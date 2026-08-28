// Routes one lab machine's Tauri IPC.
//
// Every `invoke()` the page makes lands here. Three kinds of answer:
//   * faithful  — db, identity, plugin:store: real behavior, real files.
//   * recorded  — notifications, dialogs, shortcuts, "open OS settings":
//                 side effects a scenario should be able to ASSERT on rather
//                 than perform. They are appended to `calls` and to typed
//                 records the CLI can read back.
//   * refused   — anything that would touch the host machine or the network
//                 (relaunch, sidecar spawn, model download). These fail with a
//                 clear lab-owned error instead of pretending to work, so a
//                 scenario can never mistake a stub for a pass.
//
// The distinction matters: a stub that silently succeeds turns an untested
// surface into a green scenario, which is worse than no scenario at all.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'

import {
  LabDb,
  type AuditEventRecord,
  type SessionRecord,
  type SessionTimelineRecord,
} from './db'
import { LabIdentity, type IdentityRecord } from './identity'
import { LabStores } from './store'

export type EmitToPage = (
  event: string,
  payload: unknown,
  label?: string
) => void

export type RecordedNotification = {
  ts: number
  title?: string
  body?: string
}

export type RecordedDialog = {
  ts: number
  kind: 'save' | 'open' | 'message' | 'ask' | 'confirm'
  payload: unknown
  answeredWith: unknown
}

export type RecordedWindow = {
  ts: number
  label: string
  url?: string
}

export type LabCall = { ts: number; cmd: string; args: unknown }

export type LabBackendOptions = {
  name: string
  dir: string
  emit: EmitToPage
  /** Queued answers for the next file dialogs, so a scenario can drive an
   *  export/import without a native picker. */
  dialogAnswers?: string[]
  /** Port of the lab's llama stub. Given one, the sidecar commands report a
   *  running engine on that port instead of refusing: the AI pipeline is the
   *  one place the lab has to SIMULATE rather than decline, because everything
   *  interesting about it — thresholds, streaks, alerts, audit rows — lives
   *  downstream of the one call that needs a model. */
  llamaPort?: number
}

// #236 — the raw AI observation journal. Ceilings copied from
// src-tauri/src/commands/session_journal.rs; the point of implementing this
// faithfully rather than stubbing it is that the write-up's own fallbacks are
// driven by `truncated` and by a refused append.
const JOURNAL_DIR = 'session-journals'
const JOURNAL_MAX_LINES_PER_CALL = 64
const JOURNAL_MAX_LINE_BYTES = 4 * 1024
const JOURNAL_MAX_BYTES = 2 * 1024 * 1024
const JOURNAL_MAX_READ_LINES = 20_000

// Mirrors the serde shape of `sidecar_status` (src/features/ai/sidecar.ts).
const LAB_MODEL_ID = 'lab-stub-model'
const LAB_CTX_SIZE = 4096
const LAB_HARDWARE_IDENTITY = { selection: 'cpu', topology: null }

export class LabBackend {
  readonly name: string
  readonly dir: string
  readonly db: LabDb
  readonly identity: LabIdentity
  readonly stores: LabStores
  readonly calls: LabCall[] = []
  readonly notifications: RecordedNotification[] = []
  readonly dialogs: RecordedDialog[] = []
  readonly windows: RecordedWindow[] = []
  readonly unhandled = new Map<string, number>()

  private readonly emit: EmitToPage
  private readonly logFile: string
  private readonly dialogAnswers: string[]
  private readonly llamaPort: number | null
  private sidecarRunning = false
  private readonly shortcuts = new Map<string, string>()
  private sessionActive = false
  private notificationPermission: 'granted' | 'denied' | 'default' = 'granted'
  private windowLabels = new Set(['main'])

  constructor(options: LabBackendOptions) {
    this.name = options.name
    this.dir = options.dir
    mkdirSync(this.dir, { recursive: true })
    this.db = new LabDb(path.join(this.dir, 'app.db'))
    this.identity = new LabIdentity(this.dir)
    this.stores = new LabStores(this.dir)
    this.emit = options.emit
    this.dialogAnswers = [...(options.dialogAnswers ?? [])]
    this.llamaPort = options.llamaPort ?? null
    this.logFile = path.join(this.dir, 'studyvis.log')
  }

  close(): void {
    this.db.close()
  }

  queueDialogAnswer(answer: string): void {
    this.dialogAnswers.push(answer)
  }

  logLines(limit = 500): string[] {
    if (!existsSync(this.logFile)) return []
    const lines = readFileSync(this.logFile, 'utf8').split('\n').filter(Boolean)
    return lines.slice(-limit)
  }

  // --- session journal (#236) ---------------------------------------------
  //
  // Faithful, not stubbed: `session_journal_read` is what the post-session
  // write-up narrates, and its `truncated` flag plus a refused append are the
  // inputs to the report's honesty labelling. A stub that always succeeded
  // would make that whole path untestable while looking green.

  // Session ids are session topics (32-byte SHA-256 as hex) and become
  // filenames, so anything else is REFUSED rather than sanitized — same choice
  // as `journal_file_name` in Rust, and the reason a traversal cannot reach
  // outside the machine's directory.
  private journalPath(sessionId: string): string {
    if (
      sessionId.length === 0 ||
      sessionId.length > 64 ||
      !/^[0-9a-fA-F]+$/.test(sessionId)
    ) {
      throw new Error('session id is not a session topic')
    }
    const dir = path.join(this.dir, JOURNAL_DIR)
    mkdirSync(dir, { recursive: true })
    return path.join(dir, `${sessionId.toLowerCase()}.ndjson`)
  }

  private journalAppend(sessionId: string, lines: string[]): null {
    if (lines.length === 0) return null
    if (lines.length > JOURNAL_MAX_LINES_PER_CALL) {
      throw new Error(
        `too many journal lines in one call (${lines.length} > ${JOURNAL_MAX_LINES_PER_CALL})`
      )
    }
    const file = this.journalPath(sessionId)
    let payload = ''
    for (const line of lines) {
      // A newline inside a "line" would split one observation into two records
      // the reader cannot parse.
      if (line.includes('\n') || line.includes('\r')) {
        throw new Error('journal line contains a newline')
      }
      if (Buffer.byteLength(line) > JOURNAL_MAX_LINE_BYTES) {
        throw new Error(
          `journal line too long (${Buffer.byteLength(line)} > ${JOURNAL_MAX_LINE_BYTES})`
        )
      }
      payload += `${line}\n`
    }
    // Full: the session keeps running and the report is written from what was
    // recorded, rather than failing the sample loop's fire-and-forget append
    // for the rest of the session.
    const existing = existsSync(file) ? statSync(file).size : 0
    if (existing >= JOURNAL_MAX_BYTES) return null
    appendFileSync(file, payload, { mode: 0o600 })
    return null
  }

  // Public so a scenario can assert the journal the write-up narrates, the
  // same way it reads `db.auditRows()`.
  journalRead(sessionId: string): {
    lines: string[]
    truncated: boolean
  } {
    const file = this.journalPath(sessionId)
    if (!existsSync(file)) return { lines: [], truncated: false }
    const size = statSync(file).size
    let truncated = size >= JOURNAL_MAX_BYTES
    const all = readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0)
    if (all.length > JOURNAL_MAX_READ_LINES) truncated = true
    return { lines: all.slice(0, JOURNAL_MAX_READ_LINES), truncated }
  }

  // Best-effort, like their Rust twins: a journal that outlived its session row
  // would be evidence for a report the user asked us to forget.
  private removeJournal(sessionId: string): void {
    try {
      rmSync(this.journalPath(sessionId), { force: true })
    } catch {
      // An id that is not a session topic never had a file.
    }
  }

  private clearJournals(): void {
    const dir = path.join(this.dir, JOURNAL_DIR)
    if (!existsSync(dir)) return
    for (const entry of readdirSync(dir)) {
      if (entry.endsWith('.ndjson')) {
        rmSync(path.join(dir, entry), { force: true })
      }
    }
  }

  async invoke(cmd: string, rawArgs: unknown): Promise<unknown> {
    const args = (rawArgs ?? {}) as Record<string, never>
    // app_log_append is the app's own diagnostics firehose; recording every one
    // in `calls` would bury the calls a scenario actually asserts on.
    if (cmd !== 'app_log_append') {
      this.calls.push({ ts: Date.now(), cmd, args })
    }
    if (cmd.startsWith('plugin:')) return this.plugin(cmd, args)
    return this.command(cmd, args)
  }

  // --- app commands -------------------------------------------------------

  private command(cmd: string, args: Record<string, never>): unknown {
    const a = args as unknown as Record<string, unknown>
    switch (cmd) {
      // friends
      case 'friends_list':
        return this.db.friendsList()
      case 'friends_add':
        return this.db.friendsAdd(
          String(a.edPubkey),
          String(a.xPubkey),
          String(a.name),
          Number(a.ts)
        )
      case 'friends_remove':
        return this.db.friendsRemove(String(a.edPubkey))
      case 'friends_update_last_studied':
        return this.db.friendsUpdateLastStudied(
          String(a.edPubkey),
          Number(a.ts)
        )
      case 'friends_get_x_pubkey':
        return this.db.friendsGetXPubkey(String(a.edPubkey))

      // sessions
      case 'sessions_insert':
        return this.db.sessionsInsert(
          sessionRecordFromArgs(a),
          Boolean(a.replaceFocusMetrics)
        )
      case 'sessions_insert_if_absent':
        return this.db.sessionsInsertIfAbsent(sessionRecordFromArgs(a))
      case 'sessions_list':
        return this.db.sessionsList()
      case 'sessions_get':
        return this.db.sessionsGet(String(a.id))
      case 'sessions_delete': {
        const id = String(a.id)
        this.db.sessionsDelete(id)
        // The journal is a file, not a row, so the command layer unlinks it
        // after the transaction — same order as `sessions_delete` in Rust.
        this.removeJournal(id)
        return null
      }
      case 'sessions_clear_all':
        this.db.sessionsClearAll()
        this.clearJournals()
        return null

      // session write-up (#236)
      case 'session_timeline_get':
        return this.db.sessionTimelineGet(String(a.sessionId))
      case 'session_timeline_save': {
        const row: SessionTimelineRecord = {
          session_id: String(a.sessionId),
          generated_at: Number(a.generatedAt),
          model_id: a.modelId == null ? null : String(a.modelId),
          source: String(a.source),
          entries: String(a.entries),
          truncated: a.truncated ? 1 : 0,
        }
        return this.db.sessionTimelineUpsert(row)
      }
      case 'session_journal_append':
        return this.journalAppend(
          String(a.sessionId),
          (a.lines as string[]) ?? []
        )
      case 'session_journal_read':
        return this.journalRead(String(a.sessionId))

      // audit events
      case 'audit_event_insert':
        return this.db.auditInsert({
          session_id: String(a.sessionId),
          ts: Number(a.ts),
          who: String(a.who),
          kind: String(a.kind),
          detail: String(a.detail),
          sig: String(a.sig),
        } satisfies AuditEventRecord)
      case 'audit_events_list_for_session':
        return this.db.auditListForSession(String(a.sessionId))
      case 'audit_events_list_all':
        return this.db.auditListAll()

      // identity
      case 'identity_exists':
        return this.identity.exists()
      case 'identity_keys_present':
        return this.identity.keysPresent()
      case 'identity_load_record':
        return this.identity.loadRecord()
      case 'identity_save_record':
        return this.identity.saveRecord(a.record as IdentityRecord)
      case 'identity_save_keys':
        return this.identity.saveKeys(
          String(a.edPrivHex),
          String(a.xPrivHex),
          Boolean(a.overwrite)
        )
      case 'identity_sign':
        return this.identity.sign(a.message as number[])
      case 'identity_box_encrypt':
        return this.identity.boxEncrypt(
          String(a.theirXPubHex),
          a.plaintext as number[]
        )
      case 'identity_box_decrypt':
        return this.identity.boxDecrypt(
          String(a.theirXPubHex),
          String(a.nonceB64),
          String(a.ciphertextB64)
        )

      // logging + diagnostics
      case 'app_log_append': {
        const lines = (a.lines as string[]) ?? []
        if (lines.length > 0) {
          appendFileSync(this.logFile, `${lines.join('\n')}\n`, { mode: 0o600 })
        }
        return null
      }
      case 'app_log_tail':
        return this.logLines(Number(a.maxLines ?? a.limit ?? 500))
      case 'diagnostics_info':
        return {
          log_path: this.logFile,
          data_dir: this.dir,
          app_version: 'lab',
          size_bytes: existsSync(this.logFile)
            ? readFileSync(this.logFile).byteLength
            : 0,
        }
      case 'diagnostics_reveal_log':
        return null

      // window style / layout / lifecycle
      case 'system_window_style_is_custom_applied':
        return false
      case 'session_set_active':
        this.sessionActive = Boolean(a.active)
        return null
      case 'system_battery':
        // A desktop with no battery is the shape the AI battery guard must
        // already handle, and it keeps scenarios deterministic.
        return { present: false, percentage: null, is_charging: null }
      case 'system_install_context':
        return { installed: false, writable: true, path: this.dir }

      // recorded host side effects
      case 'system_minimize_to_tray_set_enabled':
      case 'system_ai_features_set_enabled':
      case 'autostart_set_enabled':
        return null
      case 'autostart_is_enabled':
        return false
      case 'system_set_global_shortcut':
        this.shortcuts.set(String(a.action), String(a.accelerator ?? ''))
        return null
      case 'system_open_data_folder':
        return this.dir
      case 'system_open_releases':
      case 'system_open_screen_capture_settings':
      case 'system_open_camera_settings':
      case 'system_open_microphone_settings':
      case 'system_open_notification_settings':
        return null
      case 'system_write_text_file': {
        // The Rust command is a truncating `std::fs::write`, so appending here
        // would let a second export concatenate onto the first — a difference
        // a scenario asserting on file contents would have to work around.
        // The path arrives from the app (whatever the save dialog answered),
        // so it is confined to this machine's workdir: a harness running on
        // someone's real machine must not be able to write outside its own
        // sandbox, however a scenario misbehaves.
        // Owner-only: these land in a workdir under the repo on a real
        // machine, and a file the app "saved" should not be readable by every
        // account on the box just because a harness wrote it.
        writeFileSync(this.confine(String(a.path)), String(a.contents), {
          mode: 0o600,
        })
        return null
      }
      case 'ai_dialog_toggle':
      case 'toggle_ai_dialog':
        return null

      // refused: would touch the host or the network
      case 'system_relaunch_app':
      case 'app_quit':
        throw new Error(
          `lab: '${cmd}' is refused — a lab machine is torn down with 'lab down', not by the app`
        )
      case 'sidecar_start':
      case 'sidecar_stop':
      case 'sidecar_status':
        return this.sidecar(cmd)
      case 'engine_info':
        return this.llamaPort === null
          ? { installed: false, version: null, path: null }
          : { installed: true, version: 'lab-stub', path: this.dir }
      case 'engine_install':
      case 'model_download':
      case 'model_head_check':
        throw new Error(
          `lab: '${cmd}' is refused — the lab is offline and downloads nothing; start it with a llama stub instead`
        )
      case 'model_download_cancel':
        return null
      case 'model_paths': {
        const dir = path.join(this.dir, 'models', String(a.modelId))
        return {
          dir,
          model_path: path.join(dir, 'model.gguf'),
          mmproj_path: path.join(dir, 'mmproj.gguf'),
        }
      }
      case 'model_install_state':
        // A model the lab never downloaded still has to read as installed, or
        // nothing downstream of the picker ever runs.
        return this.llamaPort === null
          ? {
              model: { exists: false, size: 0 },
              mmproj: { exists: false, size: 0 },
            }
          : {
              model: { exists: true, size: 1 },
              mmproj: { exists: true, size: 1 },
            }
      case 'model_remove':
        return null
      case 'hf_token_present':
        return false
      case 'hf_token_save':
      case 'hf_token_clear':
        return null
      case 'diagnostics_export':
        return String(a.path)
      case 'friends_export':
        return this.db.friendsList().length
      case 'friends_import':
        return { added: 0, updated: 0, skipped: 0 }

      default:
        return this.unhandledCommand(cmd)
    }
  }

  private sidecar(cmd: string): unknown {
    if (this.llamaPort === null) {
      if (cmd === 'sidecar_status') {
        return {
          running: false,
          starting: false,
          port: null,
          model: null,
          mmproj: null,
          ctx_size: null,
          errored: false,
          last_error: null,
          hardware_identity: null,
        }
      }
      throw new Error(
        `lab: '${cmd}' is refused — this lab has no llama stub, and it never spawns the real llama-server`
      )
    }
    if (cmd === 'sidecar_start') {
      this.sidecarRunning = true
      return {
        port: this.llamaPort,
        hardware_identity: LAB_HARDWARE_IDENTITY,
      }
    }
    if (cmd === 'sidecar_stop') {
      this.sidecarRunning = false
      return null
    }
    return {
      running: this.sidecarRunning,
      starting: false,
      port: this.sidecarRunning ? this.llamaPort : null,
      model: this.sidecarRunning ? LAB_MODEL_ID : null,
      mmproj: null,
      ctx_size: this.sidecarRunning ? LAB_CTX_SIZE : null,
      errored: false,
      last_error: null,
      hardware_identity: this.sidecarRunning ? LAB_HARDWARE_IDENTITY : null,
    }
  }

  // --- plugin commands ----------------------------------------------------

  private plugin(cmd: string, args: Record<string, never>): unknown {
    const a = args as unknown as Record<string, unknown>
    const [namespace, command] = cmd.slice('plugin:'.length).split('|')
    switch (namespace) {
      case 'store':
        return this.stores.handle(command, a)

      case 'window':
      case 'webview':
        return this.window(command, a)

      case 'notification':
        if (command === 'is_permission_granted') {
          return this.notificationPermission === 'granted'
        }
        if (command === 'request_permission') return this.notificationPermission
        if (command === 'permission_state') return this.notificationPermission
        if (command === 'notify') {
          const options = (a.options ?? a) as { title?: string; body?: string }
          this.notifications.push({
            ts: Date.now(),
            title: options.title,
            body: options.body,
          })
          return null
        }
        if (command === 'batch') return []
        return null

      case 'dialog':
        return this.dialog(command, a)

      case 'updater':
        // Auto-update defaults ON, so UpdaterBoot checks at every boot. A
        // network error here would pollute every scenario's log; "no update"
        // is the honest offline answer.
        if (command === 'check') return null
        throw new Error(
          `lab: 'plugin:updater|${command}' is refused — the lab never applies an update`
        )

      case 'deep-link':
        if (command === 'get_current') return null
        return null

      case 'opener':
      case 'shell':
        return null

      case 'path':
        if (command === 'resolve_directory') return this.dir
        return this.dir

      case 'event': {
        // listen/unlisten are answered in the page (see bridge/initScript.ts).
        // Emits come here so they can reach this machine's OTHER windows, which
        // is how the session overlay and AI dialog actually communicate.
        if (command === 'emit') {
          this.emit(String(a.event), a.payload)
          return null
        }
        if (command === 'emit_to') {
          const target = a.target as { label?: string } | string | undefined
          const label = typeof target === 'string' ? target : target?.label
          this.emit(String(a.event), a.payload, label)
          return null
        }
        return this.unhandledCommand(cmd)
      }

      default:
        return this.unhandledCommand(cmd)
    }
  }

  private window(command: string, a: Record<string, unknown>): unknown {
    switch (command) {
      case 'get_all_windows':
      case 'get_all_webview_windows':
        return [...this.windowLabels]
      case 'create_webview_window':
      case 'create': {
        const options = (a.options ?? a) as { label?: string; url?: string }
        const label = String(
          options.label ?? `window-${this.windowLabels.size}`
        )
        this.windowLabels.add(label)
        this.windows.push({ ts: Date.now(), label, url: options.url })
        // Broadcast, not targeted at the new label: the window that asked for
        // it is the one waiting, and at this moment the new page does not
        // exist yet. Targeting the label would drop the event and leave the
        // creator hanging until its own timeout.
        queueMicrotask(() => this.emit('tauri://created', { label }))
        return null
      }
      case 'close':
      case 'destroy': {
        const label = String(a.label ?? '')
        if (label) this.windowLabels.delete(label)
        return null
      }
      case 'inner_position':
      case 'outer_position':
        return { x: 0, y: 0 }
      case 'inner_size':
      case 'outer_size':
        return { width: 1280, height: 800 }
      case 'scale_factor':
        return 1
      case 'is_maximized':
      case 'is_minimized':
      case 'is_fullscreen':
      case 'is_visible':
        return command === 'is_visible'
      case 'theme':
        return 'dark'
      default:
        // Geometry/appearance setters are no-ops in a browser page; failing
        // them would break flows that only need the call to not throw.
        return null
    }
  }

  private dialog(command: string, a: Record<string, unknown>): unknown {
    // Only the dialogs that actually return something consume a queued answer.
    // Shifting for a message box would eat the path a scenario had lined up for
    // the save picker behind it.
    const consumes =
      command === 'save' ||
      command === 'open' ||
      command === 'ask' ||
      command === 'confirm'
    const answer = consumes ? (this.dialogAnswers.shift() ?? null) : null
    const kind =
      command === 'save'
        ? 'save'
        : command === 'open'
          ? 'open'
          : command === 'ask'
            ? 'ask'
            : command === 'confirm'
              ? 'confirm'
              : 'message'
    const answeredWith =
      kind === 'ask' || kind === 'confirm' ? answer !== null : answer
    this.dialogs.push({ ts: Date.now(), kind, payload: a, answeredWith })
    return answeredWith
  }

  /** Keeps an app-supplied path inside this machine's workdir. A relative path
   *  resolves under it; an absolute one outside it is rejected rather than
   *  quietly redirected, so a scenario finds out. */
  private confine(candidate: string): string {
    const resolved = path.resolve(this.dir, candidate)
    const root = path.resolve(this.dir)
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
      throw new Error(
        `lab: refusing to write outside machine '${this.name}' workdir (${candidate})`
      )
    }
    return resolved
  }

  private unhandledCommand(cmd: string): never {
    this.unhandled.set(cmd, (this.unhandled.get(cmd) ?? 0) + 1)
    throw new Error(
      `lab: no handler for '${cmd}' — add one in lab/src/backend/index.ts`
    )
  }

  get isSessionActive(): boolean {
    return this.sessionActive
  }

  get registeredShortcuts(): Record<string, string> {
    return Object.fromEntries(this.shortcuts)
  }
}

function num(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value)
}

function str(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value)
}

function sessionRecordFromArgs(a: Record<string, unknown>): SessionRecord {
  return {
    id: String(a.id),
    started_at: num(a.startedAt),
    ended_at: num(a.endedAt),
    total_minutes: num(a.totalMinutes),
    total_duration_ms: num(a.totalDurationMs),
    peer_pubkeys: str(a.peerPubkeys),
    declared_topic: str(a.declaredTopic),
    score: num(a.score),
    focused_pct: num(a.focusedPct),
    generated_at: num(a.generatedAt),
    confident_samples: num(a.confidentSamples),
    skipped_samples: num(a.skippedSamples),
    ai_enabled: num(a.aiEnabled),
    local_ed_pubkey: str(a.localEdPubkey),
    local_display_name: str(a.localDisplayName),
    peer_presence_ms: str(a.peerPresenceMs),
  }
}
