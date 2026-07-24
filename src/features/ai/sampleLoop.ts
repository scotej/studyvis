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
import { useModelStore } from './modelStore'
import {
  parseJudgment,
  type SampleVerdict,
  type Severity,
} from './parseJudgment'
import type { ScoreEvent } from './scoreMachine'
import { DEFAULT_CTX_SIZE, useSidecarStore } from './sidecar'

// Per-tick HTTP timeout. Cold-start warmup can run ~30–90 s on CPU; the
// benchmark surfaces representative p95s into useModelStore so on the
// steady-state path 60 s is generous. If the model takes longer the tick is
// aborted, marked as a skip, and the next interval resumes.
export const REQUEST_TIMEOUT_MS = 90_000
// How often we re-read battery state — once a minute matches ARCHITECTURE
// §2's "polls this every 60 s". Cheap Tauri command so we could go faster,
// but battery state isn't moving in the milliseconds.
export const BATTERY_POLL_INTERVAL_MS = 60_000
// Sample interval defaults to whatever the V2-P2 benchmark recorded. If a
// model record is missing one (shouldn't happen, but defensive), this
// fallback keeps the loop running on the 5 s floor.
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
      console.warn('[sampleLoop] availableMonitors() failed:', err)
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
  | 'no_active_model'
  | 'model_files_missing'
  | 'sidecar_start_failed'

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
  onCaptureError?: (err: CaptureError) => void
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
  // Fires once per resolved sample with the events the score machine
  // emitted for that sample plus the sample's verdict. V2-P6 wires the
  // peer-alert + self-warning dispatcher through this callback so the
  // sample loop stays unaware of the data-channel side. Awaited so the
  // next tick does not start until the dispatcher's audit + broadcast
  // calls have resolved — keeps the "never queue" invariant honest.
  // A2 — the verdict may be an uncertain skip (parse fallback); consumers
  // must branch on it rather than read a fabricated severity.
  onScoreEvents?: (
    events: ReadonlyArray<ScoreEvent>,
    verdict: SampleVerdict
  ) => void | Promise<void>
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
  modelId: string | null
  ticks: number
  // The long-lived screen MediaStreams acquired in boot(). Empty until boot
  // resolves. Length 1 in 'primary' mode; length N in 'all' mode when N
  // displays were enumerated AND the OS granted every acquire. Tracks at
  // matching indices feed the per-tick snapshot pipeline.
  screenStreams: MediaStream[]
  screenTracks: MediaStreamTrack[]
}

export function startSampleLoop(opts: SampleLoopOptions): SampleLoopHandle {
  const runtime = activeRuntime
  const requestTimeoutMs = opts.requestTimeoutMs ?? REQUEST_TIMEOUT_MS

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
    modelId: opts.modelId,
    ticks: 0,
    screenStreams: [],
    screenTracks: [],
  }

  let tickHandle: unknown | null = null
  let batteryHandle: unknown | null = null
  let activeAbort: AbortController | null = null
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
      return
    }
    state.captureDenied = true
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

  async function stopSidecarBestEffort(): Promise<void> {
    try {
      await runtime.stopSidecar()
    } catch (err) {
      console.warn('[sampleLoop] sidecar stop failed:', err)
    }
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
    tickHandle = runtime.setTimeout(() => {
      tickHandle = null
      void tick()
    }, delayMs)
  }

  async function tick(): Promise<void> {
    if (state.stopped) return
    state.ticks += 1

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
      schedule(nextDelayMs())
      return
    }
    // S3 — camera off: reschedule without counting a sample. No skipped tally
    // (the user isn't off-task, the input is just absent) and no streak reset,
    // so focused-time % stays honest across a camera-off window.
    if (opts.isPaused?.()) {
      schedule(nextDelayMs())
      return
    }
    if (shouldPauseForBattery(state.battery)) {
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
      // The user toggled AI off mid-session. Defensive — SessionView's
      // effect should already be tearing this loop down; the check guards
      // the race where stop() hasn't landed yet.
      return
    }

    const sidecar = useSidecarStore.getState()
    if (sidecar.status === 'errored') {
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
      schedule(nextDelayMs())
      return
    }

    const track = opts.getFaceTrack()
    if (!track || track.readyState === 'ended') {
      // Either SessionView's media-acquire effect is still spinning up, or the
      // camera died mid-session (I42). Both are "input absent": reschedule
      // without counting a sample. SessionView's MediaErrorBanner owns the
      // recovery affordance for the ended case.
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
      schedule(nextDelayMs())
      return
    }

    state.inFlight = true
    activeAbort = new AbortController()
    const timer = runtime.setTimeout(() => {
      activeAbort?.abort()
    }, requestTimeoutMs)

    try {
      const [face, screen] = await Promise.all([
        runtime.captureFace(track),
        snapshotScreens(),
      ])
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
        console.warn(
          `[sampleLoop] HTTP ${response.status} from sidecar`,
          errText.slice(0, 200)
        )
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
      if (nextBackoff.justEngaged && !state.thermalNoticeShown) {
        state.thermalNoticeShown = true
        opts.onThermalBackoff?.()
      }
      state.captureErrorReported = false
      const events = useFocusStore
        .getState()
        .applyJudgment(verdict, runtime.now())
      if (opts.onScoreEvents) {
        try {
          await opts.onScoreEvents(events, verdict)
        } catch (err) {
          console.warn('[sampleLoop] onScoreEvents handler threw:', err)
        }
      }
    } catch (err) {
      if (err instanceof CaptureError) {
        if (err.code === 'screen_capture_denied') {
          // Latch and bail — V2-P9's ScreenCapturePermissionOverlay handles
          // the re-grant; the loop only resumes after a fresh start().
          state.captureDenied = true
          opts.onCaptureDenied?.()
          return
        }
        if (!state.captureErrorReported) {
          state.captureErrorReported = true
          opts.onCaptureError?.(err)
        }
        return
      }
      if (err instanceof DOMException && err.name === 'AbortError') {
        console.warn(
          `[sampleLoop] inference aborted (timeout ${requestTimeoutMs} ms)`
        )
        return
      }
      console.warn('[sampleLoop] tick failed:', err)
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
      console.warn('[sampleLoop] battery read failed:', err)
    }
  }

  // Self-teardown used by boot()'s failure paths and by stop(). Idempotent:
  // sets stopped=true (so any in-flight schedules short-circuit) and clears
  // every owned timer / abort handle. NOTE: this does NOT call
  // runtime.stopSidecar — callers decide whether to tear the sidecar down
  // (stop() does; boot() doesn't, because the sidecar wasn't successfully
  // started in the failure paths that call this).
  function teardownInternal(): void {
    state.stopped = true
    if (tickHandle !== null) {
      runtime.clearTimeout(tickHandle)
      tickHandle = null
    }
    if (batteryHandle !== null) {
      runtime.clearTimeout(batteryHandle)
      batteryHandle = null
    }
    if (activeAbort) {
      try {
        activeAbort.abort()
      } catch {
        // best-effort
      }
      activeAbort = null
    }
    // Stop the long-lived screen track so the OS screen-recording indicator
    // goes dark the moment the session (or AI) ends.
    disposeScreenStream()
  }

  async function boot(): Promise<void> {
    if (!opts.modelId) {
      opts.onStartFail?.('no_active_model')
      teardownInternal()
      return
    }

    let paths: { modelPath: string; mmprojPath: string }
    try {
      paths = await runtime.modelPaths(opts.modelId)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      opts.onStartFail?.('model_files_missing', msg)
      teardownInternal()
      return
    }

    // Read the measured cadence floor from the model store. The V2-P2
    // benchmark sets sampleIntervalSec; if the user hasn't benchmarked yet
    // (or the record was forgotten), the fallback floor keeps the loop
    // ticking but logs. The effective per-tick interval layers the user's
    // Settings → AI override on top of this floor (see effectiveIntervalSec).
    const benchmark =
      useModelStore.getState().records[opts.modelId]?.benchmark ?? null
    const interval = benchmark?.sampleIntervalSec
    if (
      typeof interval === 'number' &&
      interval >= FALLBACK_SAMPLE_INTERVAL_SEC
    ) {
      state.modelFloorSec = interval
    } else {
      console.warn(
        `[sampleLoop] no benchmark for ${opts.modelId}, using fallback ${FALLBACK_SAMPLE_INTERVAL_SEC}s`
      )
      state.modelFloorSec = FALLBACK_SAMPLE_INTERVAL_SEC
    }
    // A6 — the benchmark p95 is the baseline the cadence backoff compares each
    // tick against. 0 (no benchmark) disables backoff in nextBackoffState.
    state.modelP95Sec =
      typeof benchmark?.p95Sec === 'number' && benchmark.p95Sec > 0
        ? benchmark.p95Sec
        : 0

    // Start the sidecar BEFORE we allocate any recurring work. If it fails,
    // teardownInternal makes the start-failure handle indistinguishable
    // from a freshly-stopped one — no leaked battery timer, no stale state.
    const port = await runtime.startSidecar({
      modelPath: paths.modelPath,
      mmprojPath: paths.mmprojPath,
      ctxSize: DEFAULT_CTX_SIZE,
    })
    if (port == null) {
      const lastError = useSidecarStore.getState().lastError
      opts.onStartFail?.('sidecar_start_failed', lastError ?? undefined)
      teardownInternal()
      return
    }

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
        // Enumeration failure isn't a session-ending event — fall back to
        // single-display capture (the V2 behavior).
        console.warn('[sampleLoop] enumerateDisplayCount() failed:', err)
      }
    }

    // The first acquire is the V2-P9 contract: denial latches captureDenied
    // and surfaces onCaptureDenied so SessionView mounts the permission
    // overlay. Subsequent acquires (multi-monitor only) treat denial as a
    // soft fallback — we keep whatever displays the user already granted,
    // and the model just sees fewer screens.
    let firstStream: MediaStream
    try {
      firstStream = await runtime.acquireScreenStream()
    } catch (err) {
      if (err instanceof CaptureError && err.code === 'screen_capture_denied') {
        state.captureDenied = true
        opts.onCaptureDenied?.()
      } else if (err instanceof CaptureError) {
        opts.onCaptureError?.(err)
      } else {
        opts.onCaptureError?.(
          new CaptureError(
            'screen_capture_unavailable',
            err instanceof Error ? err.message : String(err),
            { cause: err }
          )
        )
      }
      // The sidecar was already started above; teardownInternal() does NOT
      // stop it and a later stop() short-circuits on state.stopped, so the
      // child would leak. Stop it explicitly on this post-start failure path.
      await stopSidecarBestEffort()
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
        )
      )
      await stopSidecarBestEffort()
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
        const stream = await runtime.acquireScreenStream()
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
      } catch (err) {
        // Soft fallback: a cancelled picker or any other capture error on
        // the extra-display acquires drops us back to single-display for
        // this session. We do NOT latch captureDenied — the primary stream
        // is still live and the session continues.
        if (
          !(err instanceof CaptureError) ||
          err.code !== 'screen_capture_denied'
        ) {
          console.warn(
            '[sampleLoop] additional display acquire failed:',
            err instanceof Error ? err.message : err
          )
        }
        break
      }
    }

    // Seed the battery cache before scheduling — first tick should use a
    // real reading, not the constructor default.
    await pollBattery()
    if (state.stopped) return
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
    schedule(nextDelayMs())
  }

  bootPromise = boot().catch((err) => {
    console.error('[sampleLoop] boot failed:', err)
    opts.onStartFail?.(
      'sidecar_start_failed',
      err instanceof Error ? err.message : String(err)
    )
    teardownInternal()
  })

  async function stop(): Promise<void> {
    if (state.stopped) {
      // boot()'s failure paths already called teardownInternal(); we still
      // need to await the boot promise so callers can sequence on stop()
      // returning, but there's no sidecar to tear down in that case.
      try {
        await bootPromise
      } catch {
        // boot failures already surfaced through onStartFail
      }
      return
    }
    teardownInternal()
    try {
      await bootPromise
    } catch {
      // boot failures already surfaced through onStartFail
    }
    try {
      await runtime.stopSidecar()
    } catch (err) {
      console.warn('[sampleLoop] sidecar stop failed:', err)
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
