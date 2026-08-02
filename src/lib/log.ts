// #98 — the app's structured log. One record shape, one redactor, one bounded
// ring buffer, one batched disk sink, so a diagnostic agent reads a uniform
// artifact instead of eighty ad-hoc console strings, and the sanitising I80
// added for relay text covers every call site instead of the two audited.
//
// Leaf module by construction: nothing from @/stores, @/features or
// @tauri-apps/* at module scope, and window/navigator are touched only inside
// installLogSink. That is load-bearing four times over — settingsStore,
// identityStore, friendsStore and auditStore all log, and an import cycle
// would leave their singletons undefined at boot; vitest runs node-env with no
// DOM; Storybook must not pull in Tauri; and src/components/ui/ stays free to
// import this without breaching the layering wall (DESIGN-SYSTEM §7 rule 2).
//
// ── ON-DISK SCHEMA ─────────────────────────────────────────────────────────
// <data_dir>/logs/studyvis.log, newline-delimited JSON, one LogRecord per
// line. Field names are short because they repeat on every line; `v` freezes
// them. Line one of every run is a `run.start` record carrying the app
// version, webview label and run id, so a file read cold is self-describing.
// A reader orders by (run, seq) within a process and by ts across the two
// webviews; a gap in seq means the ring evicted or the throttle collapsed.

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

// Two independent JS realms (index.html, ai-dialog.html). Each gets its own
// module instance, run id and ring buffer; only the shared file interleaves
// the two timelines.
export type LogWindow = 'main' | 'ai-dialog'

// Call sites pass raw peer / relay / model / error values straight in.
// Redaction and bounding happen here, never at the call site.
export type LogFields = Record<string, unknown>

export type LogRecord = {
  v: number
  ts: string
  // Per-run counter. A gap is an eviction, and is meant to be visible.
  seq: number
  run: string
  win: LogWindow
  lvl: LogLevel
  scope: string
  // Short stable event name ('inference.aborted'), never an interpolated
  // sentence — it is what an agent groups and counts on.
  msg: string
  // Occurrences the throttle folded into this record. Absent when 1.
  n?: number
  // Ambient session join key (8-char topic prefix), while a session is live.
  sess?: string
  data?: LogFields
}

export type Logger = {
  debug: (msg: string, fields?: LogFields) => void
  info: (msg: string, fields?: LogFields) => void
  warn: (msg: string, fields?: LogFields) => void
  error: (msg: string, fields?: LogFields) => void
  // Scopes join with '.', so child('session').child('break') is
  // 'session.break' — the same tags the old [bracket] console prefixes used,
  // so an existing issue write-up stays greppable against the new lines.
  child: (scope: string) => Logger
}

export const LOG_SCHEMA_VERSION = 1

export const REDACTED = '[redacted]'
export const REDACTED_MNEMONIC = '[redacted mnemonic]'
export const TRUNCATED = '[truncated]'

// ~500 records is a long throttled session and still pastes into an issue.
// Eviction is oldest-first through a fixed-size array used as a circle, never
// an array that grows and shifts.
export const RING_CAPACITY = 500

export const MSG_MAX_CHARS = 120
export const FIELD_MAX_CHARS = 200
// Stacks earn a longer clamp: they are the highest-value bytes in the file,
// and the path scrubber has already taken the OS username out of them.
export const STACK_MAX_CHARS = 2_000
export const FIELDS_MAX_KEYS = 24
export const FIELDS_MAX_DEPTH = 3
export const FIELDS_MAX_ARRAY = 16

// Identical non-debug (level, scope, msg) records inside this window fold onto
// the earlier record's `n` instead of appending. Debug records deliberately do
// NOT fold: they carry the per-tick timings and state transitions a bug report
// needs to reconstruct a session, and collapsing those would erase ordering.
// Higher levels still fold so one flapping relay cannot evict every boot and
// error-boundary record.
export const THROTTLE_WINDOW_MS = 10_000
export const THROTTLE_KEYS_MAX = 64

// Trailing-edge debounce, WindowLayoutListener's shape at twice its 500 ms
// because logs are chattier. error records flush now instead.
export const FLUSH_DEBOUNCE_MS = 1_000
export const FLUSH_MAX_BATCH = 64
// Hard ceiling on unflushed records: a wedged sink must cost memory nothing.
export const PENDING_MAX = 1_000
// Consecutive rejections after which the sink is dropped for the run. A broken
// sink must not retry-thrash into the thing it is observing.
export const SINK_FAILURE_LIMIT = 3

export type LogRuntime = {
  now: () => number
  // Forks globalThis vs window exactly like alertsUiStore's defaultRuntime,
  // because vitest runs node-env with no DOM.
  setTimeout: (handler: () => void, ms: number) => unknown
  clearTimeout: (handle: unknown) => void
}

const defaultRuntime: LogRuntime = {
  now: () => Date.now(),
  setTimeout: (handler, ms) =>
    typeof window === 'undefined'
      ? globalThis.setTimeout(handler, ms)
      : window.setTimeout(handler, ms),
  clearTimeout: (handle) => {
    if (typeof window === 'undefined') {
      globalThis.clearTimeout(
        handle as ReturnType<typeof globalThis.setTimeout>
      )
    } else {
      window.clearTimeout(handle as number)
    }
  },
}

let runtime: LogRuntime = { ...defaultRuntime }

// ── sanitising ─────────────────────────────────────────────────────────────

// I80, generalised. The text in a relay NOTICE, a peer's join error or a model
// reply is written by someone else, and the log is what a friend pastes into a
// public issue: a newline forges lines that read as ours, and a bidi override
// reorders what a human sees without changing the bytes. Strip both classes —
// replacing rather than deleting, so adjacent tokens don't fuse — and clamp.
const CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}]/gu

// Shape-based, not wordlist-based: importing @scure/bip39's 2048 words into a
// module every other module imports costs more than a blunt shape check, and
// over-redacting is the right direction to be wrong in at the three bare
// `console.error(err)` sites that sit inside the mnemonic path.
//
// The match is the MAXIMAL run of lowercase 3–8 letter words, and it is
// redacted only when the whole run is exactly a BIP39 length. Matching "12 or
// more" instead would swallow ordinary lowercase prose whole, which is a
// common shape in a relay notice or a backend error message.
const LOWERCASE_RUN = /[a-z]{3,8}(?:\s+[a-z]{3,8})+/g
const MNEMONIC_WORD_COUNTS = new Set([12, 15, 18, 21, 24])

// Raw rusqlite, identity and Tauri error strings routinely embed the OS
// username, and diagnostics_info's log path leaks it outright.
// The username ends at a path separator, never at a space: a Windows profile
// created from a full name is `C:\Users\John Smith`, and stopping at the
// space left the surname in a blob meant for a public issue.
const HOME_DIRS: readonly [RegExp, string][] = [
  [/(\/Users\/)[^/\\]+/g, '$1~'],
  [/(\/home\/)[^/\\]+/g, '$1~'],
  [/([A-Za-z]:\\Users\\)[^\\/]+/gi, '$1~'],
]

// Catches ed25519 pubkeys, session topics, event ids and stream ids without
// per-call-site discipline. 8 chars matches shortPubkey(), so the same friend
// reads identically in a log line and in the UI.
const LONG_HEX = /\b[0-9a-fA-F]{32,}\b/g

export function sanitizeText(
  value: unknown,
  maxChars: number = FIELD_MAX_CHARS
): string {
  let text = String(value).replace(CONTROL_OR_FORMAT, ' ')
  text = text.replace(LOWERCASE_RUN, (run) =>
    MNEMONIC_WORD_COUNTS.has(run.split(/\s+/).length) ? REDACTED_MNEMONIC : run
  )
  for (const [pattern, replacement] of HOME_DIRS) {
    text = text.replace(pattern, replacement)
  }
  text = text.replace(LONG_HEX, (hex) => `${hex.slice(0, 8)}…`)
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text
}

// Case-insensitive substring match on the KEY, applied to string values only —
// so a benign `tokenCount: 512` survives as a number while
// `turnServer.credential` never reaches the buffer.
const SECRET_KEYS = [
  'mnemonic',
  'seed',
  'passphrase',
  'password',
  'credential',
  'secret',
  'token',
  'privkey',
  'priv_key',
  'privatekey',
  'apikey',
  'api_key',
]

function isSecretKey(key: string): boolean {
  const lower = key.toLowerCase()
  return SECRET_KEYS.some((needle) => lower.includes(needle))
}

const STACK_KEYS = ['stack', 'errstack', 'componentstack']

function capFor(key: string): number {
  return STACK_KEYS.includes(key.toLowerCase())
    ? STACK_MAX_CHARS
    : FIELD_MAX_CHARS
}

function redactValue(
  key: string,
  value: unknown,
  depth: number,
  seen: Set<object>
): unknown {
  if (value === null) return null
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'string') {
    return isSecretKey(key) ? REDACTED : sanitizeText(value, capFor(key))
  }
  if (typeof value === 'function' || typeof value === 'undefined') {
    return undefined
  }
  if (typeof value !== 'object') {
    // bigint, symbol — String() then the same pipeline as any other text.
    return sanitizeText(value, capFor(key))
  }

  const object = value as object
  if (seen.has(object)) return '[circular]'
  if (depth >= FIELDS_MAX_DEPTH) return TRUNCATED
  seen.add(object)
  try {
    if (value instanceof Error) {
      // err.name survives intact — NotAllowedError vs NotFoundError is the
      // entire diagnosis at the getUserMedia sites.
      const expanded: LogFields = {
        name: value.name,
        message: sanitizeText(value.message),
      }
      if (typeof value.stack === 'string') {
        expanded.stack = sanitizeText(value.stack, STACK_MAX_CHARS)
      }
      return expanded
    }
    if (Array.isArray(value)) {
      const out = value
        .slice(0, FIELDS_MAX_ARRAY)
        .map((entry) => redactValue(key, entry, depth + 1, seen))
      if (value.length > FIELDS_MAX_ARRAY) out.push(TRUNCATED)
      return out
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      // Map, Set, DOM nodes, class instances — String() rather than a walk we
      // cannot bound meaningfully.
      return sanitizeText(value, capFor(key))
    }
    const out: LogFields = {}
    let keys = 0
    for (const [childKey, childValue] of Object.entries(value)) {
      if (keys >= FIELDS_MAX_KEYS) {
        out[TRUNCATED] = Object.keys(value).length - keys
        break
      }
      const redacted = redactValue(childKey, childValue, depth + 1, seen)
      if (redacted === undefined) continue
      out[childKey] = redacted
      keys += 1
    }
    return out
  } finally {
    seen.delete(object)
  }
}

// Applied to every fields object before it reaches the buffer, so redaction is
// a property of the logger and not of eighty call sites. Rebuilds fresh plain
// data rather than mutating the caller's object, which also means
// JSON.stringify at flush time cannot throw on a circular input.
export function redactFields(fields: LogFields): LogFields {
  const seen = new Set<object>()
  const out: LogFields = {}
  let keys = 0
  for (const [key, value] of Object.entries(fields)) {
    if (keys >= FIELDS_MAX_KEYS) {
      out[TRUNCATED] = Object.keys(fields).length - keys
      break
    }
    const redacted = redactValue(key, value, 0, seen)
    if (redacted === undefined) continue
    out[key] = redacted
    keys += 1
  }
  return out
}

// ── state ──────────────────────────────────────────────────────────────────

type ThrottleEntry = {
  index: number
  seq: number
  ts: number
  suppressed: number
}

const ring: (LogRecord | undefined)[] = new Array<LogRecord | undefined>(
  RING_CAPACITY
)
let head = 0
let filled = 0
let seq = 0
let runId = makeRunId()
let activeWindow: LogWindow = 'main'
let sessionKey: string | undefined
let debugGate: () => boolean = () => false
let writeLines: ((lines: string[]) => Promise<void>) | null = null
let recordSink: ((record: LogRecord) => void) | null = null

const throttle = new Map<string, ThrottleEntry>()
let pending: string[] = []
let timer: unknown = null
let draining: Promise<void> | null = null
let droppedRecords = 0
let writeFailures = 0
let consecutiveFailures = 0
let sinkDisabled = false
let reportedDropped = 0

function makeRunId(): string {
  const bytes = new Uint8Array(4)
  const webCrypto = (globalThis as { crypto?: Crypto }).crypto
  if (webCrypto?.getRandomValues) {
    webCrypto.getRandomValues(bytes)
  } else {
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256)
    }
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

// ── emit ───────────────────────────────────────────────────────────────────

function serialize(record: LogRecord): string {
  try {
    return JSON.stringify(record)
  } catch {
    return JSON.stringify({
      v: LOG_SCHEMA_VERSION,
      ts: record.ts,
      seq: record.seq,
      run: runId,
      win: activeWindow,
      lvl: 'error',
      scope: 'log',
      msg: 'serialize.failed',
    })
  }
}

function mirrorToConsole(record: LogRecord): void {
  // warn and error stay unconditional: all eighty migrated call sites are one
  // of those two, and hiding them behind a default-off toggle would delete
  // every diagnostic the app shows today. Only the new tiers are gated.
  let write: ((...args: unknown[]) => void) | null = null
  switch (record.lvl) {
    case 'error':
      write = console.error
      break
    case 'warn':
      write = console.warn
      break
    case 'info':
      if (debugGate()) write = console.info
      break
    case 'debug':
      if (debugGate()) write = console.debug
      break
  }
  if (!write) return
  const line = `[${record.scope}] ${record.msg}`
  // Arity stays ≤2 so devtools filtering — and any surviving console spy —
  // keeps working.
  if (record.data) write(line, record.data)
  else write(line)
}

function enqueue(record: LogRecord): void {
  pending.push(serialize(record))
  if (pending.length > PENDING_MAX) {
    pending.shift()
    droppedRecords += 1
  }
  if (record.lvl === 'error' || pending.length >= FLUSH_MAX_BATCH) {
    void drain()
    return
  }
  scheduleDrain()
}

function emit(
  level: LogLevel,
  scope: string,
  rawMsg: string,
  fields?: LogFields
): void {
  try {
    const msg = sanitizeText(rawMsg, MSG_MAX_CHARS)
    const key = `${level}|${scope}|${msg}`
    const now = runtime.now()

    // Debug is the diagnostic timeline. Preserve every sample instead of
    // folding identical event names into a count with no per-sample fields.
    const previous = level === 'debug' ? undefined : throttle.get(key)
    if (previous && now - previous.ts < THROTTLE_WINDOW_MS) {
      const slot = ring[previous.index]
      if (slot && slot.seq === previous.seq) {
        slot.n = (slot.n ?? 1) + 1
        previous.suppressed += 1
        return
      }
    }

    seq += 1
    const record: LogRecord = {
      v: LOG_SCHEMA_VERSION,
      ts: new Date(now).toISOString(),
      seq,
      run: runId,
      win: activeWindow,
      lvl: level,
      scope: scope || ROOT_SCOPE,
      msg,
    }
    if (sessionKey) record.sess = sessionKey
    if (fields) {
      const data = redactFields(fields)
      if (Object.keys(data).length > 0) record.data = data
    }

    const index = head
    ring[index] = record
    head = (head + 1) % RING_CAPACITY
    if (filled < RING_CAPACITY) filled += 1

    // Carry any un-drained tally across the window rollover. Zeroing it here
    // loses every fold whose window closed before a flush ran, which is the
    // common case for anything slower than the 1 s debounce.
    if (level !== 'debug') {
      throttle.set(key, {
        index,
        seq: record.seq,
        ts: now,
        suppressed: previous?.suppressed ?? 0,
      })
      if (throttle.size > THROTTLE_KEYS_MAX) {
        const oldest = throttle.keys().next()
        if (!oldest.done) throttle.delete(oldest.value)
      }
    }

    recordSink?.(record)
    mirrorToConsole(record)

    // Every tier reaches disk. `debugGate` controls only the developer-console
    // mirror: a user should not need to reproduce a failure after discovering
    // that verbose logging was off, especially in the preliminary test phase.
    enqueue(record)
  } catch {
    // A logger must never throw into the thing it is observing.
  }
}

function makeLogger(scope: string): Logger {
  return {
    debug: (msg, fields) => emit('debug', scope, msg, fields),
    info: (msg, fields) => emit('info', scope, msg, fields),
    warn: (msg, fields) => emit('warn', scope, msg, fields),
    error: (msg, fields) => emit('error', scope, msg, fields),
    child: (child) => makeLogger(scope ? `${scope}.${child}` : child),
  }
}

// Scope the logger's own records carry, and the fallback for anything logged
// on the root rather than a child.
const ROOT_SCOPE = 'app'

// Root logger. Call sites take a child once at module scope:
//   const log = logger.child('session.break')
export const logger: Logger = makeLogger('')

// Ambient join key stamped on every subsequent record. Session join sets it to
// the 8-char topic prefix; teardown MUST clear it, or a late callback files
// itself under a session that already ended.
export function setLogContext(ctx: { sess?: string }): void {
  const next = ctx.sess?.trim()
  // The full room topic is a join capability and never belongs in a shareable
  // log. Eight characters are enough to correlate the main and AI-dialog
  // webviews while matching shortPubkey's established diagnostic shape.
  sessionKey = next ? sanitizeText(next, 8).slice(0, 8) : undefined
}

// ── flush ──────────────────────────────────────────────────────────────────

function clearTimer(): void {
  if (timer !== null) {
    runtime.clearTimeout(timer)
    timer = null
  }
}

function scheduleDrain(): void {
  if (timer !== null || !writeLines) return
  timer = runtime.setTimeout(() => {
    timer = null
    void drain()
  }, FLUSH_DEBOUNCE_MS)
}

// Because the first occurrence of a throttled burst was written with `n`
// absent, a collapsed burst would be invisible in the file. Emit the counts
// directly rather than through emit(), which would recurse into the throttle.
function drainThrottleCounts(): void {
  for (const [key, entry] of throttle) {
    if (entry.suppressed === 0) continue
    const now = runtime.now()
    seq += 1
    pending.push(
      serialize({
        v: LOG_SCHEMA_VERSION,
        ts: new Date(now).toISOString(),
        seq,
        run: runId,
        win: activeWindow,
        lvl: 'info',
        scope: 'log',
        msg: 'repeat',
        data: { of: key, n: entry.suppressed },
      })
    )
    entry.suppressed = 0
  }
  if (droppedRecords > reportedDropped) {
    const now = runtime.now()
    seq += 1
    pending.push(
      serialize({
        v: LOG_SCHEMA_VERSION,
        ts: new Date(now).toISOString(),
        seq,
        run: runId,
        win: activeWindow,
        lvl: 'warn',
        scope: 'log',
        msg: 'dropped',
        data: { n: droppedRecords - reportedDropped },
      })
    )
    reportedDropped = droppedRecords
  }
}

function drain(): Promise<void> {
  if (draining) return draining
  const sink = writeLines
  if (!sink) return Promise.resolve()
  clearTimer()
  draining = (async () => {
    drainThrottleCounts()
    const batch = pending
    if (batch.length === 0) return
    pending = []
    try {
      await sink(batch)
      consecutiveFailures = 0
    } catch {
      // Swallowed exactly like the Rust rotate_if_needed: a failed write must
      // never surface as an error the app has to handle, and the logger must
      // never report its own failure through itself.
      writeFailures += 1
      consecutiveFailures += 1
      if (consecutiveFailures >= SINK_FAILURE_LIMIT) {
        writeLines = null
        sinkDisabled = true
      }
    }
  })().finally(() => {
    draining = null
    // Records queued while that write was in flight would otherwise sit until
    // the next emit happened to schedule a timer — a burst followed by silence
    // is exactly the crash tail this exists to keep.
    if (pending.length > 0) scheduleDrain()
  })
  return draining
}

// Awaitable drain. Re-snapshots until the queue is quiet — the PR-27
// auditStore.flushPending invariant, where a record written DURING the flush
// must still land. Never rejects. Await it before anything that replaces or
// kills the process, and before reading the tail for a bug report.
export async function flushLog(): Promise<void> {
  clearTimer()
  // Unconditionally once: the loop below skips drain() whenever `pending` is
  // empty, and folded-repeat counts live on the throttle rather than in
  // `pending` — without this they never reach the file a bug report quotes.
  if (writeLines) await drain()
  let rounds = 0
  while (writeLines && (pending.length > 0 || draining) && rounds < 16) {
    rounds += 1
    await drain()
  }
}

// ── reading back ───────────────────────────────────────────────────────────

// Newest-last records from THIS webview's ring, already redacted.
export function recentRecords(limit: number = RING_CAPACITY): LogRecord[] {
  const out: LogRecord[] = []
  const start = filled < RING_CAPACITY ? 0 : head
  for (let i = 0; i < filled; i += 1) {
    const record = ring[(start + i) % RING_CAPACITY]
    if (record) out.push(record)
  }
  return limit >= out.length ? out : out.slice(out.length - limit)
}

// One plain-text line per record, for a human or an agent. Safe to paste into
// a public issue by construction, because redaction ran at record time.
export function formatRecords(records: readonly LogRecord[]): string {
  return records
    .map((record) => {
      const level = record.lvl.padEnd(5)
      const repeat = record.n && record.n > 1 ? ` ×${record.n}` : ''
      const session = record.sess ? ` sess=${record.sess}` : ''
      const data = record.data ? ` ${JSON.stringify(record.data)}` : ''
      return `${record.ts} ${level} [${record.scope}] ${record.msg}${repeat}${session}${data}`
    })
    .join('\n')
}

// Parses NDJSON that came back from app_log_tail, skipping anything
// unparseable so a truncated first line can never break the blob.
export function parseRecordLines(lines: readonly string[]): LogRecord[] {
  const out: LogRecord[] = []
  for (const line of lines) {
    try {
      const parsed: unknown = JSON.parse(line)
      if (
        parsed &&
        typeof parsed === 'object' &&
        typeof (parsed as LogRecord).msg === 'string' &&
        typeof (parsed as LogRecord).scope === 'string'
      ) {
        out.push(parsed as LogRecord)
      }
    } catch {
      // A rolled or concurrently-appended file can hand back a fragment.
    }
  }
  return out
}

// Self-diagnostics, so a short tail is visibly short rather than silently so.
export function logHealth(): {
  buffered: number
  pending: number
  droppedRecords: number
  writeFailures: number
  sinkDisabled: boolean
} {
  return {
    buffered: filled,
    pending: pending.length,
    droppedRecords,
    writeFailures,
    sinkDisabled,
  }
}

// ── installation ───────────────────────────────────────────────────────────

export type InstallLogSinkOptions = {
  window: LogWindow
  // __APP_VERSION__ from the entry point; stamped on the run.start header
  // only, which keeps the Vite global out of this module.
  appVersion: string
  // Gates the console mirror for debug/info. Every level always reaches disk;
  // a function is still read at emit time so flipping Settings → Advanced →
  // Debug log takes effect on the next console line rather than at relaunch.
  // Injected rather than imported: settingsStore itself logs through here.
  debugEnabled?: () => boolean
  // Override for tests. Omitted in production: the real sink is built here
  // only when a Tauri runtime is detected, and reaches @tauri-apps/api/core
  // through a dynamic import inside the closure.
  writeLines?: (lines: string[]) => Promise<void>
  installGlobalHandlers?: boolean
}

function isTauriRuntime(): boolean {
  return (
    typeof window !== 'undefined' &&
    ('__TAURI_INTERNALS__' in window || '__TAURI__' in window)
  )
}

async function tauriWriteLines(lines: string[]): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core')
  await invoke('app_log_append', { lines })
}

// Called exactly once per webview, from src/main.tsx and
// src/features/ai/ai-dialog-main.tsx. Outside a Tauri runtime (Storybook,
// vitest, `npm run dev`) the sink stays null and the logger is a
// ring-buffer-plus-console no-op. Records emitted before this call are already
// in the ring and are drained by the first flush.
export function installLogSink(options: InstallLogSinkOptions): void {
  activeWindow = options.window
  debugGate = options.debugEnabled ?? (() => false)
  writeLines = options.writeLines ?? (isTauriRuntime() ? tauriWriteLines : null)
  sinkDisabled = false
  consecutiveFailures = 0

  const environment: LogFields = {
    schema: LOG_SCHEMA_VERSION,
    app: options.appVersion,
    win: options.window,
    run: runId,
  }
  if (typeof navigator !== 'undefined') {
    environment.ua = navigator.userAgent
    environment.cores = navigator.hardwareConcurrency
    environment.lang = navigator.language
  }
  if (typeof screen !== 'undefined') {
    environment.screen = `${screen.width}x${screen.height}@${
      typeof devicePixelRatio === 'number' ? devicePixelRatio : 1
    }`
  }
  logger.info('run.start', environment)

  if (
    options.installGlobalHandlers === false ||
    typeof window === 'undefined'
  ) {
    return
  }
  // The app catches neither of these today, so this is genuinely new capture.
  window.addEventListener('error', (event) => {
    logger.error('window.error', {
      message: event.message,
      source: event.filename,
      line: event.lineno,
      col: event.colno,
      err: event.error,
    })
  })
  window.addEventListener('unhandledrejection', (event) => {
    logger.error('unhandled.rejection', { err: event.reason })
  })
  // Best-effort by nature — invoke is async and beforeunload cannot await it.
  // The paths that genuinely matter await flushLog() explicitly.
  window.addEventListener('beforeunload', () => {
    void flushLog()
  })
}

// ── test seams ─────────────────────────────────────────────────────────────

export function __setLogRuntime(partial: Partial<LogRuntime>): void {
  runtime = { ...runtime, ...partial }
}

// Receives every record after redaction. Replaces the vi.spyOn(console, …)
// blocks that pin the I80 behaviour, and the deleted parseJudgment seam.
export function __setLogRecordSink(
  fn: ((record: LogRecord) => void) | null
): void {
  recordSink = fn
}

export function __resetLog(): void {
  ring.fill(undefined)
  head = 0
  filled = 0
  seq = 0
  runId = makeRunId()
  activeWindow = 'main'
  sessionKey = undefined
  debugGate = () => false
  writeLines = null
  recordSink = null
  throttle.clear()
  pending = []
  clearTimer()
  draining = null
  droppedRecords = 0
  reportedDropped = 0
  writeFailures = 0
  consecutiveFailures = 0
  sinkDisabled = false
  runtime = { ...defaultRuntime }
}
