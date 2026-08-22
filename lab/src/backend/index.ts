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

import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import path from 'node:path'

import { LabDb, type AuditEventRecord, type SessionRecord } from './db'
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
}

const AI_FEATURE_DEFAULT_SIDECAR_STATUS = {
  running: false,
  port: null,
  model_id: null,
  pid: null,
}

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
      case 'sessions_delete':
        return this.db.sessionsDelete(String(a.id))
      case 'sessions_clear_all':
        return this.db.sessionsClearAll()

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
          appendFileSync(this.logFile, `${lines.join('\n')}\n`)
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
        appendFileSync(String(a.path), String(a.contents))
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
        return { installed: false, version: null, path: null }
      case 'engine_install':
      case 'model_download':
      case 'model_head_check':
        throw new Error(
          `lab: '${cmd}' is refused — the lab is offline; point the AI at the llama stub instead`
        )
      case 'model_download_cancel':
        return null
      case 'model_paths':
        return { model_dir: path.join(this.dir, 'models'), files: [] }
      case 'model_install_state':
        return { state: 'absent', bytes: 0 }
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
    if (cmd === 'sidecar_status') return AI_FEATURE_DEFAULT_SIDECAR_STATUS
    throw new Error(
      `lab: '${cmd}' is refused — the lab never spawns llama-server; use the lab's llama stub`
    )
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
        // The creator awaits tauri://created before treating the window as
        // real; without it sessionOverlayRuntime hangs on its own timeout.
        queueMicrotask(() => this.emit('tauri://created', { label }, label))
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
    const answer = this.dialogAnswers.shift() ?? null
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
