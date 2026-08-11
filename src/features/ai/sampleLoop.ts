// V2-P5 — Per-tick capture → infer → judge → apply orchestrator.
//
// ARCHITECTURE.md §8 sample loop, in JS:
//
//   while running:
//     if previous_inference_in_flight: skip
//     if user_on_break:                skip
//     if on_battery and pct<20:        skip (cached every 60s)
//     if !sidecar_ready_or_errored:    skip (check Rust state, surface once)
//     if screen_capture_denied (latched after first denial): skip
//     ─ face = captureFace(localCameraTrack)
//     ─ screen = snapshot the long-lived screen track (acquired ONCE at boot)
//     ─ POST /v1/chat/completions { FOCUS_SYSTEM_PROMPT + topic + 2 images }
//     ─ parseJudgment(response.choices[0].message.content)
//     ─ focusStore.applyJudgment(value or fallback)
//     sleep(effective_sample_interval)   // user override clamped to floor
//
// Screen capture: README §"Acquire strategy" documents that getDisplayMedia
// in both WKWebView (macOS) and WebView2 (Windows) surfaces an OS picker on
// EVERY acquire. captureScreen()'s acquire-snapshot-release per tick would
// therefore pop the picker every 5–30 s. V2-P9 takes the documented
// contingency: one getDisplayMedia at boot, kept alive for the session,
// snapshotted per tick via the shared CaptureRuntime.extractFrame pipeline.
// The OS screen-recording indicator stays lit for the whole session (same
// visibility as the camera tile); onboarding documents this.
//
// Scheduling is a self-rescheduling setTimeout chain (not setInterval) so a
// long inference can never queue: the next tick is scheduled AFTER the
// current sample resolves. The chain matches the prompt acceptance
// criterion "inference never queues; latency-bounded sampling is observed".
//
// Runtime injection: every side-effect path (fetch, setTimeout, captures,
// battery) is reachable through `SampleLoopRuntime` so unit tests can drive
// ticks deterministically without Tauri / DOM.
//
// Sidecar lifecycle: the loop is responsible for starting the sidecar if
// it's idle (resolving model_paths from the Tauri side) and stopping it on
// teardown. This mirrors the V2-P2 benchmark.ts ownership model — every
// AI-consuming surface owns its sidecar lifecycle, so model RAM is only
// held while a consumer is active.

import { useSettingsStore } from '@/stores/settingsStore'

import {
  BATTERY_PAUSE_PERCENT,
  getBatteryRuntime,
  shouldPauseForBattery,
  type BatteryInfo,
} from './battery'
import { useBreakStore } from './breakStore'
import { captureFace as defaultCaptureFace } from './captureFace'
import {
  mapDisplayMediaError,
  SCREEN_FRAME_MAX_WIDTH,
  SCREEN_FRAME_QUALITY,
  takePendingScreenStream,
} from './captureScreen'
import {
  CaptureError,
  fitWidth,
  getCaptureRuntime,
  type CaptureFrame,
} from './captureShared'
import { COMPOSITE_MAX_WIDTH, computeCompositeLayout } from './composite'
import { getDownloadRuntime } from './download'
import { buildFocusRequest } from './focusRequest'
import { useFocusStore } from './focusStore'
import { isBenchmarkStale } from './benchmark'
import { useModelStore } from './modelStore'
import {
  isUncertainVerdict,
  parseJudgment,
  type SampleVerdict,
  type Severity,
} from './parseJudgment'
import type { ScoreEvent } from './scoreMachine'
import { DEFAULT_CTX_SIZE, useSidecarStore } from './sidecar'
import { logger } from '@/lib/log'

const log = logger.child('ai.sampleloop')

// Floor for a CURRENT benchmark-derived per-tick HTTP timeout. Cold-start
// warmup can run ~30–90 s on CPU; a valid measured p95 scales this up below.
export const REQUEST_TIMEOUT_MS = 90_000
// I83 — ceiling on how long boot() waits for the screen-capture acquire to
// settle. getDisplayMedia does not time out on its own: a picker the user never
// answers (alt-tabbed away, prompt behind the session window — WebView2 shows
// its own, and it is easy to miss) leaves the promise pending forever. boot()
// then never returns, `stop()` awaits `bootPromise` and so never returns
// either, and the sidecar it already started is never killed. Generous on
// purpose: a user genuinely reading the picker has two minutes, and the only
// cost of the ceiling is converting a permanent silent wedge into a visible,
// retryable error.
export const SCREEN_ACQUIRE_TIMEOUT_MS = 120_000
// I83/#171 — ceiling on the derived per-tick timeout below. It is also the
// conservative timeout for an unbenchmarked or stale-benchmark model. This
// matches benchmark.ts's own five-minute request bound and lets the Windows
// CPU path complete real two-image work before a trustworthy p95 exists.
export const MAX_REQUEST_TIMEOUT_MS = 300_000
// Score-event dispatch reaches the local audit store and, for alerts, the P2P
// data channel. Those side effects must not leave the sampling scheduler
// permanently in-flight after inference has already completed.
export const SCORE_EVENTS_TIMEOUT_MS = 15_000
// I83 — multiple of the benchmark-measured p95 to allow a live inference before
// aborting it. The benchmark bounds a request at 5 minutes while this loop
// bounded it at 90 s, so a model that measured a p95 above ~90 s could then
// abort every single live tick, forever, with nothing but a console.warn to
// show for it. Deriving the live bound from the same measurement closes that
// gap; 3× leaves room for the ordinary variance the cadence backoff is
// separately designed to absorb.
export const REQUEST_TIMEOUT_P95_FACTOR = 3
// How often we re-read battery state — once a minute matches ARCHITECTURE
// §2's "polls this every 60 s". Cheap Tauri command so we could go faster,
// but battery state isn't moving in the milliseconds.
export const BATTERY_POLL_INTERVAL_MS = 60_000
// A measured model uses its benchmark-derived floor. Benchmarking is optional,
// so an unmeasured model deliberately uses this 5 s fallback.
export const FALLBACK_SAMPLE_INTERVAL_SEC = 5
// Ceiling for the Settings → AI sample-interval slider. The user may slow
// sampling down to here but never below the model's measured floor (so they
// can't ask for a cadence the machine can't sustain). Mirrored by the slider
// max in AiCategory.
export const MAX_SAMPLE_INTERVAL_SEC = 30

// Effective per-tick cadence: the user's override (Settings → AI) clamped so
// it never drops below the model's measured floor and never exceeds the
// slider ceiling. `null` override → run at the floor. Read EVERY tick so a
// mid-session slider move takes effect on the next interval (V2-P5/V2-P7
// per-tick-getter discipline; same pattern as `getTopic`).
export function effectiveIntervalSec(
  modelFloorSec: number,
  userOverrideSec: number | null
): number {
  const floor = Math.max(1, modelFloorSec)
  if (userOverrideSec == null || !Number.isFinite(userOverrideSec)) {
    return floor
  }
  // Clamp the override into [floor, ceiling], but the floor wins when a slow
  // model's measured floor exceeds the ceiling (e.g. a 7B model with p95 ~30s
  // → floor 31s). The cadence must never drop below the model's floor
  // (ARCHITECTURE.md §8); applying the ceiling last would cap it at 30s and
  // force every tick to skip on the in-flight guard.
  return Math.max(floor, Math.min(MAX_SAMPLE_INTERVAL_SEC, userOverrideSec))
}

// I83/#171 — per-tick HTTP timeout derived from a current benchmark p95.
// `p95Sec` of 0 means never benchmarked, stale, or otherwise unusable. That
// path gets the conservative maximum: #171's Windows CPU request needed
// ~127–148 s, while a prompt-cache-contaminated benchmark had falsely saved a
// ~12 s p95 and the old 90 s fallback aborted every live tick. Pure so tests
// can pin the boundaries.
export function effectiveRequestTimeoutMs(p95Sec: number): number {
  if (!Number.isFinite(p95Sec) || p95Sec <= 0) {
    return MAX_REQUEST_TIMEOUT_MS
  }
  const derived = p95Sec * REQUEST_TIMEOUT_P95_FACTOR * 1000
  return Math.min(
    MAX_REQUEST_TIMEOUT_MS,
    Math.max(REQUEST_TIMEOUT_MS, Math.round(derived))
  )
}

// A6 — duration-based cadence backoff. ARCHITECTURE §8 promised a
// "thermal-aware notice" but only on-battery+<20% paused sampling — which
// never fires on AC, exactly where a fanless laptop throttles under
// continuous vision inference. Instead of OS thermal APIs (none portable; no
// telemetry), we watch tick durations: when an inference takes much longer
// than the benchmark-measured p95, the machine is throttling, so we back the
// cadence off until ticks recover. Fully local, duration-only.
//
// A tick is "slow" when its measured inference duration exceeds
// p95 * SLOW_TICK_FACTOR. The wide margin avoids reacting to ordinary jitter
// (GC, a momentarily busy CPU) — only a sustained, large overrun engages it.
export const SLOW_TICK_FACTOR = 2.5
// Consecutive slow ticks before backoff engages, and consecutive normal ticks
// before it disengages. The asymmetry (engage faster than recover) keeps the
// cadence from flapping on a machine hovering near its thermal limit.
export const BACKOFF_ENGAGE_AFTER = 2
export const BACKOFF_RECOVER_AFTER = 3
// Cadence multiplier while backed off. Doubling roughly halves the sustained
// inference duty cycle — the cheapest lever that gives the SoC headroom to
// cool without abandoning accountability entirely.
export const BACKOFF_MULTIPLIER = 2

// I82 — why a tick produced no sample. Every value here names a condition
// the loop used to skip in silence: no toast, no status-chip change, no log
// row, and (because the focus store never saw a judgment) a post-session
// report with "No focus score was recorded" and nothing explaining it. That
// is the reported Windows symptom — the loop knew, and threw it away.
//
// Deliberate pauses (break, camera off, pomodoro rest, battery) are NOT in
// this set: they already have their own surfaces and are expected to last.
export type SampleBlockReason =
  // The sidecar is not running/healthy yet — still loading the model, or
  // stuck short of the crash-restart budget that would flip it to errored.
  | 'engine_warming'
  // The inference request hit `requestTimeoutMs` and aborted. The likeliest
  // cause on a CPU-only build (Windows/Linux run `--n-gpu-layers 0`) is a
  // model too heavy for the machine, so every tick burns the full timeout.
  | 'inference_timeout'
  // The sidecar answered non-2xx, or the tick threw something unexpected.
  | 'inference_failed'
  // Snapshotting the camera or the screen keeps throwing. `onCaptureError`
  // toasts the first one and then latches, so without this the 2nd through
  // nth failures are silent.
  | 'capture_failing'
  // No live local camera track to snapshot.
  | 'camera_missing'
  // Every long-lived screen track is gone (without the denial latch firing).
  | 'screen_lost'

// How long the loop may go without a resolved sample before it says so.
// Measured from boot (or the last resolved sample / deliberate pause), NOT
// from the first blocked tick: a single slow cold start can't trip it because
// nothing is reported until at least one tick has actually failed and named a
// reason. Two minutes is short enough that the user learns inside the session
// rather than from an empty report afterwards.
export const STALL_NOTICE_AFTER_MS = 120_000

// Cadence of the stall check. It gets its own timer rather than riding the
// sample tick because a stalled loop is frequently stalled *inside* a tick:
// an inference that burns the whole REQUEST_TIMEOUT_MS (90 s) before failing
// means tick boundaries land 90 s apart, so evaluating only there pushed the
// first notice out to ~285 s — well past the two minutes this promises, on
// exactly the CPU-only-machine case the watchdog exists for.
export const STALL_CHECK_INTERVAL_MS = 15_000

// A late setTimeout is the other half of "the machine is running behind":
// inference timing catches a saturated llama-server, while this catches a
// saturated WebView main thread. Ignore ordinary timer jitter; report only a
// delay that is both at least one second and at least half of the requested
// cadence. The structured record contains timings only — never topic or frame
// data — and the global log throttle keeps a sustained overload bounded.
export const SCHEDULER_LAG_MIN_MS = 1_000
export const SCHEDULER_LAG_RATIO = 0.5

export function schedulerLagIsMaterial(
  lagMs: number,
  scheduledDelayMs: number
): boolean {
  if (!Number.isFinite(lagMs) || !Number.isFinite(scheduledDelayMs))
    return false
  if (lagMs < 0 || scheduledDelayMs < 0) return false
  return (
    lagMs >= SCHEDULER_LAG_MIN_MS &&
    lagMs >= scheduledDelayMs * SCHEDULER_LAG_RATIO
  )
}

export type BackoffState = {
  engaged: boolean
  consecutiveSlow: number
  consecutiveNormal: number
  // True exactly once, on the tick that first engages backoff this session,
  // so the consumer can fire a one-shot notice.
  justEngaged: boolean
}

export function initialBackoffState(): BackoffState {
  return {
    engaged: false,
    consecutiveSlow: 0,
    consecutiveNormal: 0,
    justEngaged: false,
  }
}

// Pure transition for the backoff state machine. `p95Sec` is the benchmark's
// measured p95 (the cost the cadence was sized against); `durationSec` is the
// just-measured inference wall-clock. When p95 is unknown/non-positive the
// backoff is disabled (we have no baseline to compare against), so the state
// is returned to rest.
export function nextBackoffState(
  prev: BackoffState,
  durationSec: number,
  p95Sec: number
): BackoffState {
  if (!Number.isFinite(p95Sec) || p95Sec <= 0) {
    return prev.engaged || prev.consecutiveSlow !== 0
      ? initialBackoffState()
      : prev
  }
  const isSlow =
    Number.isFinite(durationSec) && durationSec > p95Sec * SLOW_TICK_FACTOR
  const consecutiveSlow = isSlow ? prev.consecutiveSlow + 1 : 0
  const consecutiveNormal = isSlow ? 0 : prev.consecutiveNormal + 1

  let engaged = prev.engaged
  let justEngaged = false
  if (!engaged && consecutiveSlow >= BACKOFF_ENGAGE_AFTER) {
    engaged = true
    justEngaged = true
  } else if (engaged && consecutiveNormal >= BACKOFF_RECOVER_AFTER) {
    engaged = false
  }
  return { engaged, consecutiveSlow, consecutiveNormal, justEngaged }
}

export type SampleLoopRuntime = {
  now: () => number
  setTimeout: (handler: () => void, ms: number) => unknown
  clearTimeout: (handle: unknown) => void
  fetch: typeof fetch
  captureFace: (track: MediaStreamTrack) => Promise<string>
  // Acquire ONE long-lived screen MediaStream. V2-P9 contract: maps
  // getDisplayMedia rejections to CaptureError via the shared
  // `mapDisplayMediaError` so the screen_capture_denied latch still fires.
  // Per-tick snapshots use `getCaptureRuntime().extractFrame` on the
  // returned track — no further acquires, so no per-tick OS picker.
  //
  // V3-P4: when `captureDisplays === 'all'`, boot() calls this once per
  // enumerated display so each display gets its own long-lived stream. The
  // OS picker fires once per call, but only at session start — never on
  // a sample tick.
  acquireScreenStream: () => Promise<MediaStream>
  // V3-P4 — how many displays Tauri reports for this device. The default
  // reads `availableMonitors()` from @tauri-apps/api/window (no permission
  // needed; it's window metadata). Outside Tauri (Storybook / Vitest) the
  // default returns 1 so 'all displays' degrades to the single-stream path
  // and the existing capture flow is unchanged.
  enumerateDisplayCount: () => Promise<number>
  readBattery: () => Promise<BatteryInfo>
  // Resolved absolute paths for the active model. The default reads via the
  // Tauri `model_paths` command (V2-P2). Tests inject a stub.
  modelPaths: (
    modelId: string
  ) => Promise<{ modelPath: string; mmprojPath: string }>
  // Sidecar lifecycle. Defaults call useSidecarStore.{start,stop}. Tests
  // inject a stub. The store's status field is still the source of truth
  // for per-tick gating; these methods only initiate transitions.
  startSidecar: (params: {
    modelPath: string
    mmprojPath: string
    ctxSize: number
  }) => Promise<number | null>
  stopSidecar: () => Promise<void>
  refreshSidecarStatus: () => Promise<void>
}

const defaultRuntime: SampleLoopRuntime = {
  now: () => Date.now(),
  setTimeout: (handler, ms) =>
    typeof window === 'undefined'
      ? globalThis.setTimeout(handler, ms)
      : window.setTimeout(handler, ms),
  clearTimeout: (handle) => {
    if (typeof window === 'undefined') {
      globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>)
    } else {
      window.clearTimeout(handle as number)
    }
  },
  fetch: (...args) => fetch(...args),
  captureFace: defaultCaptureFace,
  acquireScreenStream: async () => {
    // V2-P9 gesture fix — prefer a stream a real user gesture already
    // started acquiring (see captureScreen.ts's preacquireScreenStream).
    // boot() itself runs from a useEffect with no gesture of its own, so
    // falling through to a fresh getDisplayMedia() call here throws
    // "must be called from a user gesture handler" on WebView2/WKWebView.
    const pending = takePendingScreenStream()
    if (pending) return await pending
    if (
      typeof navigator === 'undefined' ||
      !navigator.mediaDevices ||
      typeof navigator.mediaDevices.getDisplayMedia !== 'function'
    ) {
      throw new CaptureError(
        'screen_capture_unavailable',
        'navigator.mediaDevices.getDisplayMedia is not available in this environment'
      )
    }
    try {
      return await navigator.mediaDevices.getDisplayMedia({ video: true })
    } catch (err) {
      throw mapDisplayMediaError(err)
    }
  },
  enumerateDisplayCount: async () => {
    // Dynamic import keeps Tauri's window module off the Vitest + Storybook
    // boot path; both fall through to a count of 1 and the existing single-
    // stream capture flow is preserved.
    if (
      typeof window === 'undefined' ||
      (!('__TAURI_INTERNALS__' in window) && !('__TAURI__' in window))
    ) {
      return 1
    }
    try {
      const mod = await import('@tauri-apps/api/window')
      const monitors = await mod.availableMonitors()
      return Math.max(1, monitors.length)
    } catch (err) {
      // availableMonitors() can fail on platforms where the WebView hasn't
      // yet bound the window plugin. The safe degradation is single-display.
      log.warn('monitors.enumerate_failed', { degradedTo: 1, err })
      return 1
    }
  },
  readBattery: () => getBatteryRuntime().read(),
  modelPaths: async (modelId) => {
    const paths = await getDownloadRuntime().paths(modelId)
    return { modelPath: paths.model_path, mmprojPath: paths.mmproj_path }
  },
  startSidecar: async ({ modelPath, mmprojPath, ctxSize }) => {
    return useSidecarStore.getState().start({ modelPath, mmprojPath, ctxSize })
  },
  stopSidecar: async () => {
    await useSidecarStore.getState().stop()
  },
  refreshSidecarStatus: async () => {
    await useSidecarStore.getState().refreshStatus()
  },
}

let activeRuntime: SampleLoopRuntime = defaultRuntime

export function __setSampleLoopRuntime(runtime: SampleLoopRuntime): void {
  activeRuntime = runtime
}

export function __resetSampleLoopRuntime(): void {
  activeRuntime = defaultRuntime
}

export function getSampleLoopRuntime(): SampleLoopRuntime {
  return activeRuntime
}

export type SampleLoopStartReason =
  'no_active_model' | 'model_files_missing' | 'sidecar_start_failed'

export type SampleLoopOptions = {
  // Declared study topic. Read per-tick via callback so a mid-session
  // topic_change via the V2-P7 Ctrl+] dialog takes effect on the NEXT
  // inference without restarting the loop. V2-P9 will wire the same
  // pattern to the session-start input.
  getTopic: () => string
  // Live reference to the local camera track owned by SessionView. Read
  // per-tick (not captured at start) so a mid-session device swap (V1-P11
  // audio swap; future video swap) lands on the same handle.
  getFaceTrack: () => MediaStreamTrack | null
  // S3 — when the user turns their camera off mid-session the video track is
  // disabled (still 'live', so getFaceTrack would return it and we'd analyze a
  // black frame). Read per-tick; when it returns true the loop reschedules
  // WITHOUT counting a sample (no skipped tally, no streak reset) and WITHOUT
  // tearing down loop state — mirrors the onBreak / battery-pause pattern so
  // resume is seamless. Optional; defaults to never-paused.
  isPaused?: () => boolean
  // Override the per-tick HTTP timeout. Used by tests; production sticks
  // with REQUEST_TIMEOUT_MS.
  requestTimeoutMs?: number
  // The active model id. If null the loop refuses to start and onStartFail
  // fires with 'no_active_model' so the consumer can render a "pick a
  // model in Settings → AI" empty state (V2-P2 carry-forward).
  modelId: string | null
  // Optional callbacks for terminal/notable conditions. UI wiring lives in
  // SessionView (V2-P5) and Settings → AI (V2-P9). All callbacks fire at
  // most once per loop lifetime unless documented otherwise.
  onStartFail?: (reason: SampleLoopStartReason, detail?: string) => void
  onCaptureDenied?: () => void
  // `fatal` distinguishes a boot()-time acquire failure (the loop tears
  // itself down + stops the sidecar; AI is now dead until a fresh start())
  // from a tick()-time transient capture failure (the loop keeps
  // rescheduling and may recover on its own next tick). Consumers use this
  // to decide whether to reflect an "errored" runtime status or just toast.
  onCaptureError?: (err: CaptureError, fatal: boolean) => void
  onSidecarErrored?: (lastError: string | null) => void
  // §8 battery pause. Fires once when the loop enters the on-battery-<20%
  // paused state, and `onBatteryResume` once when it leaves. Without these the
  // user never learns why accountability went quiet. (The §8 "thermal" concern
  // on AC power is handled separately by the duration-based cadence backoff —
  // see `onThermalBackoff` and `nextBackoffState`.)
  onBatteryPause?: (info: BatteryInfo) => void
  onBatteryResume?: () => void
  // A6 — fires ONCE per loop lifetime, the first time the duration-based
  // cadence backoff engages (sustained inference overrun vs the benchmark
  // p95, i.e. the machine is throttling). SessionView wires a one-shot
  // in-voice toast. No payload: the notice is informational, not actionable.
  onThermalBackoff?: () => void
  // I82 — fires when the loop has gone STALL_NOTICE_AFTER_MS without a
  // resolved sample for a reason the user can't otherwise see, carrying the
  // most recent reason. Re-arms after `onSamplesResumed`, so a session that
  // stalls, recovers, and stalls again reports both — but a single stall can
  // never repeat-toast. Consumers surface it AND record it, because the
  // post-session report is where its absence was noticed.
  //
  // Every path this covers used to be a bare `console.warn` and a reschedule:
  // a sidecar that spawns but never reports healthy, an HTTP error from a model
  // whose vision projector failed to load, an inference that aborts on the
  // per-tick timeout every time, a `fetch` TypeError. In release builds there
  // is no devtools and llama-server.log holds none of it, so the entire
  // session ran with the AI chip reading "watching" and the report recorded
  // nothing — which is exactly what issue #92 looked like from the user's side.
  // Paused states (break, camera off, pomodoro rest, battery) are deliberately
  // NOT stalls: nothing is wrong and nothing is being hidden.
  //
  // I83's consecutive-tick counter (STALL_TICKS) was the first cut at this and
  // is superseded here: it counted the cold-start ticks that boot() documents
  // as "gracefully skip" while llama-server loads the model, so a healthy
  // CPU-only session toasted "the engine isn't responding" ~15-30 s in and had
  // no resume path to take it back. A wall-clock window measures the thing the
  // user actually experiences, and re-arms.
  onSamplesStalled?: (reason: SampleBlockReason) => void
  // Fires once after a reported stall when a sample finally resolves. The
  // reason + unavailable duration are safe diagnostic metadata and let the
  // session persist a matching recovery row beside `ai_stalled`.
  onSamplesResumed?: (recovery: SampleRecoveryInfo) => void
  // Fires once per resolved sample with the events the score machine
  // emitted for that sample plus the sample's verdict. V2-P6 wires the
  // peer-alert + self-warning dispatcher through this callback so the
  // sample loop stays unaware of the data-channel side. It is awaited only
  // up to SCORE_EVENTS_TIMEOUT_MS: this preserves the usual serial ordering
  // while a hung audit/broadcast callback cannot wedge future inference.
  // A2 — the verdict may be an uncertain skip (parse fallback); consumers
  // must branch on it rather than read a fabricated severity.
  onScoreEvents?: (
    events: ReadonlyArray<ScoreEvent>,
    verdict: SampleVerdict,
    context: ScoreEventsDispatchContext
  ) => void | Promise<void>
}

export type SampleRecoveryInfo = {
  reason: SampleBlockReason
  unavailableForMs: number
}

// A score-event callback owns external work (audit persistence and P2P
// delivery). The loop cannot cancel an arbitrary promise, so it gives the
// consumer an explicit lifetime it can honor before performing later effects.
export type ScoreEventsDispatchContext = {
  signal: AbortSignal
}

export type SampleLoopHandle = {
  stop: () => Promise<void>
  // Test introspection. Production code should not depend on this shape.
  __state: () => InternalState
}

type InternalState = {
  stopped: boolean
  inFlight: boolean
  captureDenied: boolean
  sidecarErrorReported: boolean
  // Report-once latch for `onCaptureError`, cleared by the next successful
  // tick. A persistent capture failure (a dead camera, a screen frame grab
  // that keeps failing) throws every tick, and the consumer toast is not
  // deduped — without this the user gets the same toast every 5-30 s for the
  // rest of the session. Mirrors `sidecarErrorReported`.
  captureErrorReported: boolean
  battery: BatteryInfo
  batteryNoticeShown: boolean
  // The model's measured cadence floor (V2-P2 benchmark). The effective
  // interval the scheduler uses is computed per-tick from this floor plus the
  // user's Settings → AI override — see `effectiveIntervalSec()`.
  modelFloorSec: number
  // A6 — the benchmark-measured p95 inference duration (seconds), the baseline
  // the cadence backoff compares each tick against. 0 when no benchmark exists
  // (backoff is then disabled — no baseline to throttle against).
  modelP95Sec: number
  // A6 — duration-based cadence backoff state. Mutated after each resolved
  // inference via `nextBackoffState`.
  backoff: BackoffState
  // A6 — one-shot latch for the thermal-backoff notice. `nextBackoffState`
  // sets `justEngaged` on EVERY disengaged→engaged edge (the machine is
  // correct as an engagement-edge signal), but the consumer contract is
  // once-per-loop-lifetime. Backoff can recover (BACKOFF_RECOVER_AFTER normal
  // ticks) and re-engage within the same session — e.g. the user closes a
  // heavy app so ticks speed up, then reopens it — which would re-fire
  // `justEngaged` and re-toast. This latch keeps the documented once-only
  // contract; mirrors `batteryNoticeShown` / `sidecarErrorReported`.
  thermalNoticeShown: boolean
  // I82 — stall watchdog. `lastProgressAt` is the last moment the loop was
  // demonstrably fine: boot, a resolved sample, or a deliberate pause.
  // `stallReason` is the most recent blocked-tick reason and doubles as the
  // arming flag — null means nothing has failed since the last progress, so
  // there is nothing to report. `stallReported` is the report-once latch that
  // `onSamplesResumed` clears.
  lastProgressAt: number
  stallReason: SampleBlockReason | null
  stallReported: boolean
  // The reason that actually triggered the user-visible stall notice. Keep it
  // separate from `stallReason`: later blocked ticks can change reason, and a
  // deliberate pause resets the live reason while the notice remains open.
  reportedStallReason: SampleBlockReason | null
  // Last-progress timestamp captured on the same edge as the notice. Unlike
  // `lastProgressAt`, this survives a deliberate pause so the recovery log's
  // unavailable duration still spans the full unresolved interval.
  reportedStallSince: number | null
  modelId: string | null
  ticks: number
  resolvedSamples: number
  // The long-lived screen MediaStreams acquired in boot(). Empty until boot
  // resolves. Length 1 in 'primary' mode; length N in 'all' mode when N
  // displays were enumerated AND the OS granted every acquire. Tracks at
  // matching indices feed the per-tick snapshot pipeline.
  screenStreams: MediaStream[]
  screenTracks: MediaStreamTrack[]
}

export function startSampleLoop(opts: SampleLoopOptions): SampleLoopHandle {
  const runtime = activeRuntime
  // I83 — an explicit override wins verbatim (the unit tests drive short
  // timeouts through it); otherwise the bound is derived per tick from the
  // model's measured p95 via `effectiveRequestTimeoutMs`.
  const requestTimeoutOverrideMs = opts.requestTimeoutMs ?? null
  const loopStartedAt = runtime.now()

  log.info('loop.created', {
    modelId: opts.modelId,
    requestTimeoutMode:
      requestTimeoutOverrideMs === null ? 'p95-derived' : 'override',
    requestTimeoutMs: requestTimeoutOverrideMs,
  })

  const state: InternalState = {
    stopped: false,
    inFlight: false,
    captureDenied: false,
    sidecarErrorReported: false,
    captureErrorReported: false,
    battery: { onBattery: false, percent: 100 },
    batteryNoticeShown: false,
    modelFloorSec: FALLBACK_SAMPLE_INTERVAL_SEC,
    modelP95Sec: 0,
    backoff: initialBackoffState(),
    thermalNoticeShown: false,
    lastProgressAt: 0,
    stallReason: null,
    stallReported: false,
    reportedStallReason: null,
    reportedStallSince: null,
    modelId: opts.modelId,
    ticks: 0,
    resolvedSamples: 0,
    screenStreams: [],
    screenTracks: [],
  }

  let tickHandle: unknown | null = null
  let batteryHandle: unknown | null = null
  // I82 — stall watchdog timer. Separate from the tick chain on purpose; see
  // STALL_CHECK_INTERVAL_MS.
  let stallHandle: unknown | null = null
  let activeAbort: AbortController | null = null
  // The one bounded post-inference callback currently holding the tick chain.
  // Its signal makes an elapsed deadline or teardown observable to the
  // callback; resolving the deadline alone cannot cancel its promise.
  let activeScoreEventsDispatch: {
    token: object
    handle: unknown
    resolve: () => void
    controller: AbortController
  } | null = null
  // Surfaces the long-running boot work (refusal checks, sidecar start) so
  // stop() can wait for it before returning. Without this, an immediate
  // stop() could race the still-pending model_paths fetch.
  let bootPromise: Promise<void> | null = null

  // Recomputed every call (every reschedule) so a mid-session Settings → AI
  // slider move lands on the next interval without restarting the loop. A6 —
  // while the cadence backoff is engaged, the interval is stretched by
  // BACKOFF_MULTIPLIER to give a throttling machine room to recover.
  function nextDelayMs(): number {
    const override = useSettingsStore.getState().values.sampleIntervalSec
    const baseMs = effectiveIntervalSec(state.modelFloorSec, override) * 1000
    return state.backoff.engaged ? baseMs * BACKOFF_MULTIPLIER : baseMs
  }

  // I82 — a tick ended without a sample for a reason nothing else surfaces.
  // Arms the watchdog with the reason; the decision to report is
  // `evaluateStall`'s, so a tick that itself took longer than the notice
  // window doesn't delay the notice by its own duration.
  function noteBlockedTick(reason: SampleBlockReason): void {
    if (state.stopped) return
    if (state.stallReason !== reason) {
      log.debug('tick.blocked', {
        tick: state.ticks,
        reason,
        sinceProgressMs: Math.max(0, runtime.now() - state.lastProgressAt),
      })
    }
    state.stallReason = reason
    evaluateStall()
  }

  // The single place that decides "this loop has gone quiet and the user
  // should be told". Called from blocked ticks AND from the standalone
  // watchdog timer, so an inference hung for the full request timeout can't
  // hide the condition until it finally rejects.
  function evaluateStall(): void {
    if (state.stopped) return
    // A denial already surfaced through onCaptureDenied and mounted the
    // permission overlay; a second notice underneath it would be noise.
    if (state.captureDenied) return
    if (state.stallReported) return
    const reason = state.stallReason
    // Nothing has failed since the last progress — a loop mid-inference on a
    // healthy machine is not stalled, it's working.
    if (reason === null) return
    if (runtime.now() - state.lastProgressAt < STALL_NOTICE_AFTER_MS) return
    state.stallReported = true
    state.reportedStallReason = reason
    state.reportedStallSince = state.lastProgressAt
    log.warn('stall.reported', {
      reason,
      tick: state.ticks,
      sinceProgressMs: Math.max(0, runtime.now() - state.lastProgressAt),
      resolvedSamples: state.resolvedSamples,
      modelId: state.modelId,
      modelP95Sec: state.modelP95Sec,
      effectiveIntervalMs: nextDelayMs(),
      requestTimeoutMs:
        requestTimeoutOverrideMs ??
        effectiveRequestTimeoutMs(state.modelP95Sec),
      backoffEngaged: state.backoff.engaged,
      onBattery: state.battery.onBattery,
    })
    opts.onSamplesStalled?.(reason)
  }

  // A deliberate pause (break, camera off, pomodoro rest, battery, AI toggled
  // off, an errored sidecar that already toasted) is not a stall — treat it as
  // progress so a long break can't be mistaken for one, and disarm the reason
  // so the watchdog timer has nothing to report while paused. The report-once
  // latch deliberately survives: a stall that was already reported is still
  // outstanding until a sample actually lands, and the consumer's own state
  // (SessionView's `aiStalled` ref) stays consistent with that.
  function resetStallClock(): void {
    state.lastProgressAt = runtime.now()
    state.stallReason = null
  }

  // A sample resolved: the loop is demonstrably working again. Re-arm the
  // watchdog, and tell the consumer if it had been told otherwise.
  function noteSampleResolved(): void {
    if (state.stopped) return
    const lastBlockedReason = state.stallReason
    const wasReported = state.stallReported
    const reportedReason = state.reportedStallReason
    const unavailableForMs = Math.max(
      0,
      runtime.now() - (state.reportedStallSince ?? state.lastProgressAt)
    )
    resetStallClock()
    if (!wasReported) return
    state.stallReported = false
    state.reportedStallReason = null
    state.reportedStallSince = null
    // `reportedStallReason` is set on the same edge as `stallReported`, so the
    // fallback is defensive for any future state migration/test seam.
    const reason = reportedReason ?? lastBlockedReason
    if (reason === null) return
    log.info('stall.recovered', {
      previousReason: reason,
      lastBlockedReason,
      tick: state.ticks,
      unavailableForMs,
      resolvedSamples: state.resolvedSamples,
      modelId: state.modelId,
      modelP95Sec: state.modelP95Sec,
      effectiveIntervalMs: nextDelayMs(),
      backoffEngaged: state.backoff.engaged,
    })
    opts.onSamplesResumed?.({ reason, unavailableForMs })
  }

  // The dispatcher can await SQLite and P2P work. Inference has already
  // completed by this point, so holding the only tick chain forever would
  // silently stop sampling while the watchdog sees a recent resolved sample.
  // Bound the callback rather than making it fully concurrent: normal event
  // batches retain their ordering, while a broken network path only delays a
  // subsequent sample for this small, explicit deadline.
  async function dispatchScoreEventsBounded(
    events: ReadonlyArray<ScoreEvent>,
    verdict: SampleVerdict
  ): Promise<void> {
    const onScoreEvents = opts.onScoreEvents
    if (!onScoreEvents) return

    let timedOut = false
    const deadlineToken = {}
    const controller = new AbortController()
    const context: ScoreEventsDispatchContext = {
      signal: controller.signal,
    }
    try {
      await Promise.race([
        Promise.resolve().then(() => onScoreEvents(events, verdict, context)),
        new Promise<void>((resolve) => {
          const deadline = {
            token: deadlineToken,
            handle: null as unknown,
            resolve,
            controller,
          }
          activeScoreEventsDispatch = deadline
          deadline.handle = runtime.setTimeout(() => {
            timedOut = true
            // Promise.race cannot stop callback work. Abort makes the lost
            // race explicit so consumers can suppress later UI/audit/P2P
            // effects when their own awaited operation eventually settles.
            controller.abort()
            if (activeScoreEventsDispatch?.token === deadlineToken) {
              activeScoreEventsDispatch = null
            }
            resolve()
          }, SCORE_EVENTS_TIMEOUT_MS)
        }),
      ])
    } catch (err) {
      // An abort caused by the timeout or teardown is expected. A consumer
      // may use it to reject its own promise, but that must not mask the
      // timeout diagnostic or become a noisy post-stop warning.
      if (!controller.signal.aborted && !state.stopped) {
        log.warn('score_events.threw', {
          eventCount: events.length,
          verdictKind: isUncertainVerdict(verdict)
            ? 'uncertain'
            : verdict.severity,
          err,
        })
      }
    } finally {
      if (activeScoreEventsDispatch?.token === deadlineToken) {
        runtime.clearTimeout(activeScoreEventsDispatch.handle)
        activeScoreEventsDispatch = null
      }
    }
    // A signal-aware consumer can reject before the deadline promise wins
    // Promise.race. Keep timeout reporting outside the catch so that expected
    // cancellation does not hide the reason the scheduler moved on.
    if (timedOut) {
      log.warn('score_events.timeout', {
        eventCount: events.length,
        verdictKind: isUncertainVerdict(verdict)
          ? 'uncertain'
          : verdict.severity,
        timeoutMs: SCORE_EVENTS_TIMEOUT_MS,
      })
    }
  }

  // A screen track ended — the user clicked the OS "Stop sharing" pill, or a
  // display went away (undock / sleep / unplug). In 'all' mode we hold several
  // long-lived displays; losing ONE while others stay live must NOT tear down
  // all AI capture and pop the screen-permission overlay (misleading — no
  // permission was revoked). Drop just the dead display and keep compositing
  // the rest. Only when the LAST live display is gone do we latch like a
  // denial, requiring a fresh start() (via the overlay) to resume — same
  // contract as screen_capture_denied.
  function onScreenTrackEnded(event: Event): void {
    if (state.stopped) return
    if (state.captureDenied) return
    const endedTrack =
      event.target instanceof MediaStreamTrack ? event.target : null
    // Count tracks still live after this 'ended' (the ended track's readyState
    // is already 'ended' when the event fires).
    const liveRemaining = state.screenTracks.filter(
      (t) => t.readyState !== 'ended'
    ).length
    if (liveRemaining > 0) {
      if (endedTrack) dropScreenTrack(endedTrack)
      log.info('screen_track.ended', {
        liveRemaining,
        captureStopped: false,
      })
      return
    }
    state.captureDenied = true
    log.warn('screen_track.ended', {
      liveRemaining: 0,
      captureStopped: true,
    })
    opts.onCaptureDenied?.()
  }

  // Remove one dead display from the tracked set: unhook its listener, stop its
  // stream, and splice it out of the parallel screenTracks/screenStreams arrays
  // so snapshotScreens composites only the survivors.
  function dropScreenTrack(track: MediaStreamTrack): void {
    try {
      track.removeEventListener('ended', onScreenTrackEnded)
    } catch {
      // best-effort
    }
    const idx = state.screenTracks.indexOf(track)
    if (idx === -1) {
      try {
        track.stop()
      } catch {
        // ignore
      }
      return
    }
    const stream = state.screenStreams[idx]
    if (stream) {
      for (const t of stream.getTracks()) {
        try {
          t.stop()
        } catch {
          // ignore
        }
      }
    }
    state.screenTracks.splice(idx, 1)
    state.screenStreams.splice(idx, 1)
  }

  function disposeScreenStream(): void {
    for (const track of state.screenTracks) {
      try {
        track.removeEventListener('ended', onScreenTrackEnded)
      } catch {
        // best-effort
      }
    }
    for (const stream of state.screenStreams) {
      for (const t of stream.getTracks()) {
        try {
          t.stop()
        } catch {
          // already-stopped tracks throw on some platforms; ignore
        }
      }
    }
    state.screenStreams = []
    state.screenTracks = []
  }

  // Snapshot a single long-lived screen track through the SAME pipeline
  // captureScreen.ts uses internally (fitWidth + CaptureRuntime). No
  // getDisplayMedia here, so no per-tick OS picker.
  async function snapshotSingleScreen(
    track: MediaStreamTrack
  ): Promise<string> {
    const cap = getCaptureRuntime()
    const frame = await cap.extractFrame(track)
    try {
      const { width, height } = fitWidth(
        frame.sourceWidth,
        frame.sourceHeight,
        SCREEN_FRAME_MAX_WIDTH
      )
      if (width === 0 || height === 0) {
        throw new CaptureError(
          'frame_extraction_failed',
          `screen frame had unusable dimensions (${frame.sourceWidth}×${frame.sourceHeight})`
        )
      }
      return await cap.encodeJpegBase64({
        frame,
        targetWidth: width,
        targetHeight: height,
        quality: SCREEN_FRAME_QUALITY,
      })
    } finally {
      cap.disposeFrame(frame)
    }
  }

  // V3-P4 — snapshot every long-lived screen track and composite them into a
  // single horizontal-strip image at most COMPOSITE_MAX_WIDTH wide. No
  // getDisplayMedia here either; the streams were acquired at boot.
  async function snapshotAllScreens(
    tracks: ReadonlyArray<MediaStreamTrack>
  ): Promise<string> {
    const cap = getCaptureRuntime()
    const frames: CaptureFrame[] = []
    try {
      for (const track of tracks) {
        frames.push(await cap.extractFrame(track))
      }
      const layout = computeCompositeLayout(
        frames.map((f) => ({
          sourceWidth: f.sourceWidth,
          sourceHeight: f.sourceHeight,
        })),
        COMPOSITE_MAX_WIDTH
      )
      if (
        layout.outputWidth === 0 ||
        layout.outputHeight === 0 ||
        layout.placements.length === 0
      ) {
        throw new CaptureError(
          'frame_extraction_failed',
          'composite frame had unusable dimensions'
        )
      }
      return await cap.encodeCompositeJpegBase64({
        placements: layout.placements.map((p, i) => ({
          frame: frames[i]!,
          x: p.x,
          y: p.y,
          width: p.width,
          height: p.height,
        })),
        outputWidth: layout.outputWidth,
        outputHeight: layout.outputHeight,
        quality: SCREEN_FRAME_QUALITY,
      })
    } finally {
      for (const f of frames) cap.disposeFrame(f)
    }
  }

  // Release every screen stream past the primary one. Called when the user
  // demotes from 'all' to 'primary' mid-session so the OS screen-recording
  // indicator goes dark for the deselected displays right away — keeping
  // those streams live would be a surprising privacy/perf cost. The 'ended'
  // listener is removed BEFORE stop() so the explicit release doesn't latch
  // captureDenied (only a real revoke from the OS should latch).
  function releaseExtraScreenStreams(): void {
    if (state.screenTracks.length <= 1) return
    const extraTracks = state.screenTracks.slice(1)
    const extraStreams = state.screenStreams.slice(1)
    log.info('screen_capture.demoted', {
      releasedDisplayCount: extraStreams.length,
      remainingDisplayCount: 1,
    })
    state.screenTracks = state.screenTracks.slice(0, 1)
    state.screenStreams = state.screenStreams.slice(0, 1)
    for (const track of extraTracks) {
      try {
        track.removeEventListener('ended', onScreenTrackEnded)
      } catch {
        // best-effort
      }
    }
    for (const stream of extraStreams) {
      for (const t of stream.getTracks()) {
        try {
          t.stop()
        } catch {
          // already-stopped tracks throw on some platforms; ignore
        }
      }
    }
  }

  // Dispatch per tick. Reads `captureDisplays` from settings on every call so
  // an all→primary mid-session switch demotes immediately: this tick stops
  // compositing AND releases the streams the model no longer needs, so the
  // OS recording indicator goes dark for the deselected displays. A
  // primary→all switch can't grow the stream set mid-session without a new
  // OS prompt, so it takes effect on the next loop boot — consistent with
  // V2-P9's no-prompt-per-tick contract.
  async function snapshotScreens(): Promise<string> {
    const mode = useSettingsStore.getState().values.captureDisplays
    if (mode === 'primary') {
      releaseExtraScreenStreams()
    }
    const tracks = state.screenTracks
    if (tracks.length === 0) {
      throw new CaptureError(
        'screen_capture_no_video',
        'no live screen tracks to snapshot'
      )
    }
    const liveTracks = tracks.filter((t) => t.readyState !== 'ended')
    if (liveTracks.length === 0) {
      throw new CaptureError(
        'screen_capture_no_video',
        'all screen tracks have ended'
      )
    }
    if (mode === 'all' && liveTracks.length > 1) {
      return await snapshotAllScreens(liveTracks)
    }
    return await snapshotSingleScreen(liveTracks[0]!)
  }

  function schedule(delayMs: number): void {
    if (state.stopped) return
    if (tickHandle !== null) {
      runtime.clearTimeout(tickHandle)
      tickHandle = null
    }
    const scheduledAt = runtime.now()
    const dueAt = scheduledAt + delayMs
    tickHandle = runtime.setTimeout(() => {
      tickHandle = null
      void tick({ delayMs, dueAt })
    }, delayMs)
  }

  async function tick(scheduleInfo?: {
    delayMs: number
    dueAt: number
  }): Promise<void> {
    if (state.stopped) return
    state.ticks += 1
    const tickStartedAt = runtime.now()
    const schedulerLagMs = scheduleInfo
      ? Math.max(0, tickStartedAt - scheduleInfo.dueAt)
      : 0
    if (
      scheduleInfo &&
      schedulerLagIsMaterial(schedulerLagMs, scheduleInfo.delayMs)
    ) {
      log.warn('scheduler.lagged', {
        tick: state.ticks,
        lagMs: schedulerLagMs,
        scheduledDelayMs: scheduleInfo.delayMs,
        resolvedSamples: state.resolvedSamples,
        modelId: state.modelId,
        modelP95Sec: state.modelP95Sec,
        backoffEngaged: state.backoff.engaged,
        onBattery: state.battery.onBattery,
      })
    }

    if (state.inFlight) {
      // The previous sample's network/encode/parse is still resolving. Do
      // NOT enqueue another — skip this tick and let the in-flight one
      // schedule the next at its `finally` block.
      return
    }
    if (state.captureDenied) {
      // Permission was denied earlier in this loop; no point looping until
      // the user re-toggles. The consumer (V2-P9) restarts the loop after
      // re-granting + clicking the toggle.
      return
    }
    if (useBreakStore.getState().onBreak) {
      resetStallClock()
      schedule(nextDelayMs())
      return
    }
    // S3 — camera off: reschedule without counting a sample. No skipped tally
    // (the user isn't off-task, the input is just absent) and no streak reset,
    // so focused-time % stays honest across a camera-off window.
    if (opts.isPaused?.()) {
      resetStallClock()
      schedule(nextDelayMs())
      return
    }
    if (shouldPauseForBattery(state.battery)) {
      resetStallClock()
      if (!state.batteryNoticeShown) {
        state.batteryNoticeShown = true
        opts.onBatteryPause?.(state.battery)
      }
      // §8: re-check on the 60 s battery cadence while paused, not the
      // (shorter) sample interval — no point spinning the loop faster
      // than battery state can change.
      schedule(BATTERY_POLL_INTERVAL_MS)
      return
    }
    if (state.batteryNoticeShown) {
      state.batteryNoticeShown = false
      opts.onBatteryResume?.()
    }
    if (!useSettingsStore.getState().values.aiFeaturesEnabled) {
      resetStallClock()
      // The user toggled AI off mid-session. Defensive — SessionView's
      // effect should already be tearing this loop down; the check guards
      // the race where stop() hasn't landed yet.
      return
    }

    const sidecar = useSidecarStore.getState()
    if (sidecar.status === 'errored') {
      // Already surfaced through its own channel — don't double-report it
      // as a stall too.
      resetStallClock()
      if (!state.sidecarErrorReported) {
        state.sidecarErrorReported = true
        opts.onSidecarErrored?.(sidecar.lastError)
      }
      schedule(nextDelayMs())
      return
    }
    state.sidecarErrorReported = false
    const gatedPort = sidecar.port
    if (sidecar.status !== 'running' || !sidecar.healthy || gatedPort == null) {
      // Sidecar isn't ready (still starting, restarting after a crash, or
      // /health hasn't returned 2xx yet). Refresh the Rust-side status so
      // we pick up the "3 restart attempts exhausted → errored" transition
      // that the JS-side /health poll alone can't see.
      try {
        await runtime.refreshSidecarStatus()
      } catch {
        // best-effort; we'll try again next tick
      }
      // A sidecar that never becomes healthy is the single most common way AI
      // runs a whole session recording nothing. Blocked (not paused), so the
      // watchdog reports it instead of the chip reading "AI watching" over a
      // dead engine — but on the wall clock, so a slow cold start isn't
      // mistaken for a dead one.
      noteBlockedTick('engine_warming')
      schedule(nextDelayMs())
      return
    }

    const track = opts.getFaceTrack()
    if (!track || track.readyState === 'ended') {
      // Either SessionView's media-acquire effect is still spinning up, or the
      // camera died mid-session (I42). Both are "input absent": reschedule
      // without counting a sample. SessionView's MediaErrorBanner owns the
      // recovery affordance for the ended case.
      noteBlockedTick('camera_missing')
      schedule(nextDelayMs())
      return
    }

    const modelId = state.modelId
    if (!modelId) {
      schedule(nextDelayMs())
      return
    }

    if (
      state.screenTracks.length === 0 ||
      state.screenTracks.every((t) => t.readyState === 'ended')
    ) {
      // boot() acquired these; if they're all gone the 'ended' handler has
      // already latched captureDenied. Skip defensively.
      noteBlockedTick('screen_lost')
      schedule(nextDelayMs())
      return
    }

    state.inFlight = true
    activeAbort = new AbortController()
    const tickTimeoutMs =
      requestTimeoutOverrideMs ?? effectiveRequestTimeoutMs(state.modelP95Sec)
    const timer = runtime.setTimeout(() => {
      activeAbort?.abort()
    }, tickTimeoutMs)

    try {
      const captureStartedAt = runtime.now()
      const [face, screen] = await Promise.all([
        runtime.captureFace(track),
        snapshotScreens(),
      ])
      const captureMs = Math.max(0, runtime.now() - captureStartedAt)
      // A5 — the Rust watcher may have respawned the sidecar on a fresh
      // ephemeral port during the capture window. Re-read the port right
      // before the POST; if it moved or went away, bail and reschedule this
      // tick rather than fire at a dead port (a guaranteed failure that
      // burns the whole tick budget on a timeout).
      const sidecarNow = useSidecarStore.getState()
      const port = sidecarNow.port
      if (
        sidecarNow.status !== 'running' ||
        !sidecarNow.healthy ||
        port == null ||
        port !== gatedPort
      ) {
        noteBlockedTick('engine_warming')
        return
      }
      const body = buildFocusRequest({
        modelId,
        topic: opts.getTopic(),
        faceBase64: face,
        screenBase64: screen,
      })
      // A6 — time the inference round-trip (the compute that a throttling SoC
      // slows down) so the cadence backoff can compare it to the benchmark p95.
      const inferenceStart = runtime.now()
      const response = await runtime.fetch(
        `http://127.0.0.1:${port}/v1/chat/completions`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: activeAbort.signal,
        }
      )
      if (!response.ok) {
        const errText = await response.text().catch(() => '')
        // Keep only shape. A sidecar error can echo request material, which
        // includes the user's declared topic and encoded captures.
        log.warn('sidecar.http_error', {
          httpStatus: response.status,
          bodyLength: errText.length,
          modelId: opts.modelId,
          tick: state.ticks,
          elapsedMs: Math.max(0, runtime.now() - tickStartedAt),
        })
        noteBlockedTick('inference_failed')
        return
      }
      const json = (await response.json()) as ChatCompletionResponse
      const content = json?.choices?.[0]?.message?.content ?? ''
      // A2 — a malformed/empty response is an UNCERTAIN skip, not a fabricated
      // on_task: it neither resets an in-progress off-task streak nor counts
      // toward focused-time %. The verdict (real judgment or uncertain) threads
      // through applyJudgment and onScoreEvents so SessionView can decide what,
      // if anything, to surface.
      const parsed = parseJudgment(content)
      const verdict: SampleVerdict = parsed.ok ? parsed.value : parsed.fallback
      // A6 — a completed round-trip is a valid duration sample for the backoff
      // machine. Aborted / errored ticks don't reach here, so a single hung
      // request (which already aborts at requestTimeoutMs) never alone trips
      // backoff; only sustained real overruns do.
      const inferenceSec = (runtime.now() - inferenceStart) / 1000
      const nextBackoff = nextBackoffState(
        state.backoff,
        inferenceSec,
        state.modelP95Sec
      )
      state.backoff = nextBackoff
      if (
        state.modelP95Sec > 0 &&
        inferenceSec > state.modelP95Sec * SLOW_TICK_FACTOR
      ) {
        log.warn('inference.slow', {
          tick: state.ticks,
          modelId,
          inferenceMs: Math.round(inferenceSec * 1000),
          benchmarkP95Ms: Math.round(state.modelP95Sec * 1000),
          slowThresholdMs: Math.round(
            state.modelP95Sec * SLOW_TICK_FACTOR * 1000
          ),
          consecutiveSlow: nextBackoff.consecutiveSlow,
          backoffEngaged: nextBackoff.engaged,
          effectiveIntervalMs: nextDelayMs(),
          schedulerLagMs,
          onBattery: state.battery.onBattery,
        })
      }
      if (nextBackoff.justEngaged && !state.thermalNoticeShown) {
        state.thermalNoticeShown = true
        opts.onThermalBackoff?.()
      }
      state.captureErrorReported = false
      // A resolved sample (confident OR uncertain) means the pipeline is alive
      // end to end, so the stall clock starts over and a reported stall is
      // announced as recovered.
      noteSampleResolved()
      const events = useFocusStore
        .getState()
        .applyJudgment(verdict, runtime.now())
      await dispatchScoreEventsBounded(events, verdict)
      state.resolvedSamples += 1
      log.debug('sample.resolved', {
        tick: state.ticks,
        resolvedSamples: state.resolvedSamples,
        modelId,
        displayCount: state.screenTracks.filter(
          (screenTrack) => screenTrack.readyState !== 'ended'
        ).length,
        captureMs,
        inferenceMs: Math.round(inferenceSec * 1000),
        totalMs: Math.max(0, runtime.now() - tickStartedAt),
        verdict: isUncertainVerdict(verdict) ? 'uncertain' : verdict.severity,
        parseOk: parsed.ok,
        scoreEventCount: events.length,
        backoffEngaged: state.backoff.engaged,
        nextDelayMs: nextDelayMs(),
        schedulerLagMs,
        onBattery: state.battery.onBattery,
      })
    } catch (err) {
      if (err instanceof CaptureError) {
        if (err.code === 'screen_capture_denied') {
          // Latch and bail — V2-P9's ScreenCapturePermissionOverlay handles
          // the re-grant; the loop only resumes after a fresh start().
          state.captureDenied = true
          log.warn('capture.denied', {
            phase: 'tick',
            tick: state.ticks,
          })
          opts.onCaptureDenied?.()
          return
        }
        if (!state.captureErrorReported) {
          state.captureErrorReported = true
          log.warn('capture.failed', {
            phase: 'tick',
            tick: state.ticks,
            code: err.code,
            fatal: false,
          })
          opts.onCaptureError?.(err, false)
        }
        noteBlockedTick('capture_failing')
        return
      }
      if (err instanceof DOMException && err.name === 'AbortError') {
        // The "why did focus detection stop scoring" line — the cadence
        // state is what makes it answerable. The bound is the p95-derived
        // tick timeout, not the old flat constant.
        log.warn('inference.aborted', {
          timeoutMs: tickTimeoutMs,
          modelId: opts.modelId,
          onBattery: state.battery.onBattery,
          tick: state.ticks,
        })
        noteBlockedTick('inference_timeout')
        return
      }
      log.warn('tick.failed', {
        modelId: opts.modelId,
        tick: state.ticks,
        elapsedMs: Math.max(0, runtime.now() - tickStartedAt),
        err,
      })
      noteBlockedTick('inference_failed')
    } finally {
      runtime.clearTimeout(timer)
      activeAbort = null
      state.inFlight = false
      schedule(nextDelayMs())
    }
  }

  async function pollBattery(): Promise<void> {
    try {
      state.battery = await runtime.readBattery()
    } catch (err) {
      // Fires on every poll on unsupported hardware — debug, not a warning.
      log.debug('battery.read_failed', { err })
    }
  }

  // Self-teardown used by boot()'s failure paths and by stop(). Idempotent:
  // sets stopped=true (so any in-flight schedules short-circuit) and clears
  // every owned timer / abort handle. NOTE: this does NOT call
  // runtime.stopSidecar — callers decide whether to tear the sidecar down
  // (stop() does; boot() doesn't, because the sidecar wasn't successfully
  // started in the failure paths that call this).
  function teardownInternal(): void {
    if (state.stopped) return
    log.info('loop.teardown', {
      modelId: state.modelId,
      elapsedMs: Math.max(0, runtime.now() - loopStartedAt),
      ticks: state.ticks,
      resolvedSamples: state.resolvedSamples,
      liveDisplayCount: state.screenTracks.filter(
        (track) => track.readyState !== 'ended'
      ).length,
      captureDenied: state.captureDenied,
      stallReported: state.stallReported,
      backoffEngaged: state.backoff.engaged,
    })
    state.stopped = true
    if (tickHandle !== null) {
      runtime.clearTimeout(tickHandle)
      tickHandle = null
    }
    if (batteryHandle !== null) {
      runtime.clearTimeout(batteryHandle)
      batteryHandle = null
    }
    if (stallHandle !== null) {
      runtime.clearTimeout(stallHandle)
      stallHandle = null
    }
    if (activeAbort) {
      try {
        activeAbort.abort()
      } catch {
        // best-effort
      }
      activeAbort = null
    }
    if (activeScoreEventsDispatch) {
      const deadline = activeScoreEventsDispatch
      activeScoreEventsDispatch = null
      runtime.clearTimeout(deadline.handle)
      deadline.controller.abort()
      deadline.resolve()
    }
    // Stop the long-lived screen track so the OS screen-recording indicator
    // goes dark the moment the session (or AI) ends.
    disposeScreenStream()
  }

  // I83 — `runtime.acquireScreenStream()` with a deadline. A stream that
  // arrives after the deadline is stopped rather than leaked: the caller has
  // already moved on to its failure path, so nothing would ever release those
  // tracks and the OS recording indicator would stay lit with no session
  // behind it.
  async function acquireScreenStreamBounded(): Promise<MediaStream> {
    let timer: ReturnType<typeof runtime.setTimeout> | null = null
    let timedOut = false
    const attempt = runtime.acquireScreenStream()
    try {
      return await Promise.race([
        attempt,
        new Promise<never>((_resolve, reject) => {
          timer = runtime.setTimeout(() => {
            timedOut = true
            reject(
              new CaptureError(
                'screen_capture_unavailable',
                `screen capture was not granted within ${Math.round(
                  SCREEN_ACQUIRE_TIMEOUT_MS / 1000
                )}s (the screen-share prompt may be waiting behind another window)`
              )
            )
          }, SCREEN_ACQUIRE_TIMEOUT_MS)
        }),
      ])
    } finally {
      if (timer !== null) runtime.clearTimeout(timer)
      if (timedOut) {
        void attempt
          .then((late) => {
            for (const t of late.getTracks()) {
              try {
                t.stop()
              } catch {
                // already-stopped tracks throw on some platforms; ignore.
              }
            }
          })
          .catch(() => {
            // The acquire failed on its own after we gave up — nothing to
            // release, and the timeout error is what the caller already saw.
          })
      }
    }
  }

  async function boot(): Promise<void> {
    const bootStartedAt = runtime.now()
    log.info('boot.started', { modelId: opts.modelId })
    if (!opts.modelId) {
      log.warn('boot.refused', { reason: 'no_active_model' })
      opts.onStartFail?.('no_active_model')
      teardownInternal()
      return
    }

    let paths: { modelPath: string; mmprojPath: string }
    try {
      paths = await runtime.modelPaths(opts.modelId)
    } catch (err) {
      if (state.stopped) return
      const msg = err instanceof Error ? err.message : String(err)
      log.warn('boot.refused', {
        modelId: opts.modelId,
        reason: 'model_files_missing',
        err,
      })
      opts.onStartFail?.('model_files_missing', msg)
      teardownInternal()
      return
    }
    // React cleanup cannot await boot(). A path lookup that completes after
    // teardown belongs to an obsolete loop and must not open a capture prompt.
    if (state.stopped) return

    // I83 — screen capture is acquired BEFORE the sidecar, not after. Both
    // orders tear down cleanly, but this one never asks llama-server to load
    // a multi-GB model that a failed acquire is about to kill milliseconds
    // later: the reported symptom was "model does not load into machine",
    // with `[event] terminated code=None` and no stderr in the diagnostic log
    // (the child died before it could print its banner). Acquire first and a
    // capture failure costs nothing but the picker.
    //
    // V3-P4 — decide how many screen streams to acquire BEFORE the first
    // getDisplayMedia call. Reading the setting once here (not per tick) is
    // why "All displays" applies on the next loop boot rather than mid-
    // session — there is no way to add a long-lived stream later without a
    // new OS picker, which V2-P9 explicitly forbids mid-tick.
    const captureMode = useSettingsStore.getState().values.captureDisplays
    let acquireTargetCount = 1
    if (captureMode === 'all') {
      try {
        const reported = await runtime.enumerateDisplayCount()
        if (Number.isFinite(reported) && reported > 1) {
          acquireTargetCount = Math.floor(reported)
        }
      } catch (err) {
        if (state.stopped) return
        // Enumeration failure isn't a session-ending event — fall back to
        // single-display capture (the V2 behavior).
        log.warn('displays.enumerate_failed', {
          captureMode: 'all',
          degradedTo: 1,
          err,
        })
      }
      if (state.stopped) return
    }
    log.info('screen_capture.planned', {
      captureMode,
      targetDisplayCount: acquireTargetCount,
    })

    // The first acquire is the V2-P9 contract: denial latches captureDenied
    // and surfaces onCaptureDenied so SessionView mounts the permission
    // overlay. Subsequent acquires (multi-monitor only) treat denial as a
    // soft fallback — we keep whatever displays the user already granted,
    // and the model just sees fewer screens.
    const captureAcquireStartedAt = runtime.now()
    let firstStream: MediaStream
    try {
      firstStream = await acquireScreenStreamBounded()
    } catch (err) {
      // A pending picker may reject after SessionView has replaced this loop.
      // Its teardown is silent; only the still-active loop may surface errors.
      if (state.stopped) return
      const code =
        err instanceof CaptureError ? err.code : 'screen_capture_unavailable'
      if (err instanceof CaptureError && err.code === 'screen_capture_denied') {
        state.captureDenied = true
        opts.onCaptureDenied?.()
      } else if (err instanceof CaptureError) {
        opts.onCaptureError?.(err, true)
      } else {
        opts.onCaptureError?.(
          new CaptureError(
            'screen_capture_unavailable',
            err instanceof Error ? err.message : String(err),
            { cause: err }
          ),
          true
        )
      }
      log.warn('screen_capture.failed', {
        phase: 'boot_primary',
        code,
        fatal: true,
        elapsedMs: Math.max(0, runtime.now() - captureAcquireStartedAt),
      })
      // No sidecar to unwind — I83 moved the spawn below this acquire, so a
      // capture failure now costs nothing beyond the loop itself.
      teardownInternal()
      return
    }
    if (state.stopped) {
      for (const t of firstStream.getTracks()) {
        try {
          t.stop()
        } catch {
          // ignore
        }
      }
      return
    }
    const firstTrack = firstStream.getVideoTracks()[0]
    if (!firstTrack) {
      for (const t of firstStream.getTracks()) {
        try {
          t.stop()
        } catch {
          // ignore
        }
      }
      opts.onCaptureError?.(
        new CaptureError(
          'screen_capture_no_video',
          'getDisplayMedia returned a stream with no video tracks'
        ),
        true
      )
      log.warn('screen_capture.failed', {
        phase: 'boot_primary',
        code: 'screen_capture_no_video',
        fatal: true,
        elapsedMs: Math.max(0, runtime.now() - captureAcquireStartedAt),
      })
      teardownInternal()
      return
    }
    state.screenStreams.push(firstStream)
    state.screenTracks.push(firstTrack)
    firstTrack.addEventListener('ended', onScreenTrackEnded)

    // Acquire any additional displays for 'all' mode. Each call shows the OS
    // picker once; the user picks the next monitor. If they cancel any of
    // these prompts (or the OS errors), we stop asking and keep whatever
    // streams the user already granted — no error. The session then composites
    // however many displays it ended up with (one = the single-display path).
    for (let i = 1; i < acquireTargetCount; i += 1) {
      if (state.stopped) return
      try {
        const stream = await acquireScreenStreamBounded()
        const track = stream.getVideoTracks()[0]
        if (!track) {
          // Defensive — degraded into a no-track stream. Release and stop
          // acquiring further; the run continues with whatever we have.
          for (const t of stream.getTracks()) {
            try {
              t.stop()
            } catch {
              // ignore
            }
          }
          break
        }
        if (state.stopped) {
          for (const t of stream.getTracks()) {
            try {
              t.stop()
            } catch {
              // ignore
            }
          }
          return
        }
        state.screenStreams.push(stream)
        state.screenTracks.push(track)
        track.addEventListener('ended', onScreenTrackEnded)
        log.debug('screen_capture.display_added', {
          acquiredDisplayCount: state.screenTracks.length,
          targetDisplayCount: acquireTargetCount,
        })
      } catch (err) {
        // Soft fallback: a cancelled picker or any other capture error on
        // the extra-display acquires drops us back to single-display for
        // this session. We do NOT latch captureDenied — the primary stream
        // is still live and the session continues.
        if (
          !(err instanceof CaptureError) ||
          err.code !== 'screen_capture_denied'
        ) {
          log.warn('display.acquire_failed', {
            acquireTargetCount,
            latchedDenied: false,
            err,
          })
        }
        break
      }
    }
    log.info('screen_capture.ready', {
      acquiredDisplayCount: state.screenTracks.length,
      targetDisplayCount: acquireTargetCount,
      elapsedMs: Math.max(0, runtime.now() - captureAcquireStartedAt),
    })

    // Every screen the model will see is now in hand, so it is finally worth
    // paying for the model itself. If the spawn fails, teardownInternal()
    // releases the streams we just acquired along with the rest of the loop.
    if (state.stopped) return
    const sidecarStartedAt = runtime.now()
    log.info('sidecar.starting', {
      modelId: opts.modelId,
      ctxSize: DEFAULT_CTX_SIZE,
    })
    const port = await runtime.startSidecar({
      modelPath: paths.modelPath,
      mmprojPath: paths.mmprojPath,
      ctxSize: DEFAULT_CTX_SIZE,
    })
    // stop() intentionally cancels an in-flight singleton start before a
    // replacement loop boots. That obsolete start may resolve null after the
    // store marks it superseded; it is teardown, not a user-visible failure.
    if (state.stopped) return
    if (port == null) {
      const lastError = useSidecarStore.getState().lastError
      log.warn('boot.sidecar_failed', {
        modelId: opts.modelId,
        elapsedMs: Math.max(0, runtime.now() - sidecarStartedAt),
        hasError: lastError !== null,
      })
      opts.onStartFail?.('sidecar_start_failed', lastError ?? undefined)
      teardownInternal()
      return
    }
    log.info('sidecar.ready', {
      modelId: opts.modelId,
      elapsedMs: Math.max(0, runtime.now() - sidecarStartedAt),
    })

    // Read benchmark cadence only after the native sidecar start has resolved
    // and stored its canonical selection/topology identity. On a normal app
    // relaunch Settings may never mount, so checking earlier would see no
    // identity and incorrectly discard a matching persisted benchmark for the
    // entire session.
    const storedBenchmark =
      useModelStore.getState().records[opts.modelId]?.benchmark ?? null
    // #171 — the cache-cold benchmark protocol is part of the fingerprint.
    // Old records can be far too optimistic, so unlike the pre-fix code they
    // do not drive cadence, slowdown detection, or the live request timeout.
    const benchmark =
      storedBenchmark && !isBenchmarkStale(storedBenchmark)
        ? storedBenchmark
        : null
    const benchmarkStale = storedBenchmark !== null && benchmark === null
    const interval = benchmark?.sampleIntervalSec
    if (
      typeof interval === 'number' &&
      interval >= FALLBACK_SAMPLE_INTERVAL_SEC
    ) {
      state.modelFloorSec = interval
    } else {
      // Not a fault: an unmeasured or stale model gets the safe fallback until
      // the user runs the current cache-cold benchmark.
      log.info(benchmarkStale ? 'benchmark.stale' : 'benchmark.missing', {
        modelId: opts.modelId,
        fallbackIntervalSec: FALLBACK_SAMPLE_INTERVAL_SEC,
        fallbackRequestTimeoutMs: MAX_REQUEST_TIMEOUT_MS,
      })
      state.modelFloorSec = FALLBACK_SAMPLE_INTERVAL_SEC
    }
    // A6 — the benchmark p95 is the baseline the cadence backoff compares each
    // tick against. 0 (no benchmark) disables backoff in nextBackoffState.
    state.modelP95Sec =
      typeof benchmark?.p95Sec === 'number' && benchmark.p95Sec > 0
        ? benchmark.p95Sec
        : 0
    log.info('boot.cadence', {
      modelId: opts.modelId,
      benchmarkPresent: storedBenchmark !== null,
      benchmarkCurrent: benchmark !== null,
      modelFloorSec: state.modelFloorSec,
      modelP95Sec: state.modelP95Sec,
      effectiveIntervalSec: effectiveIntervalSec(
        state.modelFloorSec,
        useSettingsStore.getState().values.sampleIntervalSec
      ),
    })

    // Seed the battery cache before scheduling — first tick should use a
    // real reading, not the constructor default.
    await pollBattery()
    if (state.stopped) return
    // I82 — the stall window runs from here: the loop is about to start
    // ticking, so from this moment on "no resolved sample" is meaningful.
    state.lastProgressAt = runtime.now()
    stallHandle = runtime.setTimeout(function stallTick() {
      if (state.stopped) return
      evaluateStall()
      stallHandle = runtime.setTimeout(stallTick, STALL_CHECK_INTERVAL_MS)
    }, STALL_CHECK_INTERVAL_MS)
    batteryHandle = runtime.setTimeout(function batteryTick() {
      if (state.stopped) return
      void pollBattery().finally(() => {
        if (state.stopped) return
        batteryHandle = runtime.setTimeout(
          batteryTick,
          BATTERY_POLL_INTERVAL_MS
        )
      })
    }, BATTERY_POLL_INTERVAL_MS)

    // First tick fires on the sample-interval clock, not synchronously, so
    // the sidecar has time to /health-poll into the healthy state. If it
    // takes longer than one interval, the first few ticks gracefully skip
    // and refreshSidecarStatus() picks up an errored transition.
    const initialDelayMs = nextDelayMs()
    log.info('boot.ready', {
      modelId: opts.modelId,
      elapsedMs: Math.max(0, runtime.now() - bootStartedAt),
      displayCount: state.screenTracks.length,
      initialDelayMs,
      onBattery: state.battery.onBattery,
    })
    schedule(initialDelayMs)
  }

  bootPromise = boot().catch((err) => {
    // A stop can also make the in-flight sidecar start reject. The replacement
    // loop owns startup now, so the obsolete loop must not emit a false toast.
    if (state.stopped) return
    log.error('boot.failed', {
      modelId: opts.modelId,
      failCode: 'sidecar_start_failed',
      err,
    })
    opts.onStartFail?.(
      'sidecar_start_failed',
      err instanceof Error ? err.message : String(err)
    )
    teardownInternal()
  })

  async function stop(): Promise<void> {
    const stopStartedAt = runtime.now()
    if (state.stopped) {
      // boot()'s failure paths already called teardownInternal(); we still
      // need to await the boot promise so callers can sequence on stop()
      // returning, but there's no sidecar to tear down in that case.
      try {
        await bootPromise
      } catch {
        // boot failures already surfaced through onStartFail
      }
      log.debug('stop.completed', {
        alreadyStopped: true,
        elapsedMs: Math.max(0, runtime.now() - stopStartedAt),
      })
      return
    }
    teardownInternal()
    // Claim the singleton stop before waiting for this loop's boot work. A
    // replacement React effect can start immediately after cleanup returns;
    // entering the sidecar store's stop path now makes that new caller wait
    // for the old process instead of joining a start this loop will later kill.
    let sidecarStop:
      | { started: true; settled: Promise<{ error: unknown } | null> }
      | { started: false; error: unknown }
    try {
      sidecarStop = {
        started: true,
        // bootPromise can span multiple event-loop turns. Settle the stop
        // rejection now so it cannot surface as unhandled while boot winds
        // down; the error is still reported after the sequencing await.
        settled: runtime.stopSidecar().then(
          () => null,
          (error: unknown) => ({ error })
        ),
      }
    } catch (err) {
      sidecarStop = { started: false, error: err }
    }
    try {
      await bootPromise
    } catch {
      // boot failures already surfaced through onStartFail
    }
    try {
      if (!sidecarStop.started) throw sidecarStop.error
      const failure = await sidecarStop.settled
      if (failure) throw failure.error
      log.info('stop.completed', {
        alreadyStopped: false,
        elapsedMs: Math.max(0, runtime.now() - stopStartedAt),
        ticks: state.ticks,
        resolvedSamples: state.resolvedSamples,
      })
    } catch (err) {
      // Matters for the updater path: a sidecar we failed to stop makes a
      // worse install.
      log.warn('sidecar.stop_failed', { cmd: 'sidecar_stop', err })
    }
  }

  return {
    stop,
    __state: () => state,
  }
}

type ChatCompletionResponse = {
  choices?: Array<{
    message?: { content?: string }
    finish_reason?: string
  }>
}

// Re-exported for tests that want to assert specific request shapes. The
// builder itself now lives in focusRequest.ts (A1) so the benchmark, the
// eval harness, and this loop share one source of truth.
export const __internals = {
  buildChatRequest: buildFocusRequest,
  BATTERY_PAUSE_PERCENT,
}

// Convenience for any caller that wants the registry severity list without
// importing parseJudgment.
export type { Severity }
