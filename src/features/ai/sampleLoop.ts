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
//     ─ screen = captureScreen()
//     ─ POST /v1/chat/completions { FOCUS_SYSTEM_PROMPT + topic + 2 images }
//     ─ parseJudgment(response.choices[0].message.content)
//     ─ focusStore.applyJudgment(value or fallback)
//     sleep(sample_interval)
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
import { captureScreen as defaultCaptureScreen } from './captureScreen'
import { CaptureError } from './captureShared'
import { getDownloadRuntime } from './download'
import { useFocusStore } from './focusStore'
import { useModelStore } from './modelStore'
import { parseJudgment, type Severity } from './parseJudgment'
import { DEFAULT_CTX_SIZE, useSidecarStore } from './sidecar'
import { FOCUS_SYSTEM_PROMPT } from './systemPrompt'

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

export type SampleLoopRuntime = {
  now: () => number
  setTimeout: (handler: () => void, ms: number) => unknown
  clearTimeout: (handle: unknown) => void
  fetch: typeof fetch
  captureFace: (track: MediaStreamTrack) => Promise<string>
  captureScreen: () => Promise<string>
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
  captureScreen: defaultCaptureScreen,
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
  // Declared study topic. V2-P9 replaces the hardcoded "Studying" default
  // with the user's required session-start input.
  topic: string
  // Live reference to the local camera track owned by SessionView. Read
  // per-tick (not captured at start) so a mid-session device swap (V1-P11
  // audio swap; future video swap) lands on the same handle.
  getFaceTrack: () => MediaStreamTrack | null
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
  battery: BatteryInfo
  sampleIntervalSec: number
  modelId: string | null
  ticks: number
}

export function startSampleLoop(opts: SampleLoopOptions): SampleLoopHandle {
  const runtime = activeRuntime
  const requestTimeoutMs = opts.requestTimeoutMs ?? REQUEST_TIMEOUT_MS

  const state: InternalState = {
    stopped: false,
    inFlight: false,
    captureDenied: false,
    sidecarErrorReported: false,
    battery: { onBattery: false, percent: 100 },
    sampleIntervalSec: FALLBACK_SAMPLE_INTERVAL_SEC,
    modelId: opts.modelId,
    ticks: 0,
  }

  let tickHandle: unknown | null = null
  let batteryHandle: unknown | null = null
  let activeAbort: AbortController | null = null
  // Surfaces the long-running boot work (refusal checks, sidecar start) so
  // stop() can wait for it before returning. Without this, an immediate
  // stop() could race the still-pending model_paths fetch.
  let bootPromise: Promise<void> | null = null

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
      schedule(state.sampleIntervalSec * 1000)
      return
    }
    if (shouldPauseForBattery(state.battery)) {
      schedule(state.sampleIntervalSec * 1000)
      return
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
      schedule(state.sampleIntervalSec * 1000)
      return
    }
    state.sidecarErrorReported = false
    if (
      sidecar.status !== 'running' ||
      !sidecar.healthy ||
      sidecar.port == null
    ) {
      // Sidecar isn't ready (still starting, restarting after a crash, or
      // /health hasn't returned 2xx yet). Refresh the Rust-side status so
      // we pick up the "3 restart attempts exhausted → errored" transition
      // that the JS-side /health poll alone can't see.
      try {
        await runtime.refreshSidecarStatus()
      } catch {
        // best-effort; we'll try again next tick
      }
      schedule(state.sampleIntervalSec * 1000)
      return
    }

    const track = opts.getFaceTrack()
    if (!track) {
      // SessionView's media-acquire effect is still spinning up. Try again
      // next tick.
      schedule(state.sampleIntervalSec * 1000)
      return
    }

    const modelId = state.modelId
    if (!modelId) {
      schedule(state.sampleIntervalSec * 1000)
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
        runtime.captureScreen(),
      ])
      const port = sidecar.port
      const body = buildChatRequest({
        modelId,
        topic: opts.topic,
        faceBase64: face,
        screenBase64: screen,
      })
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
      // V2-P4 parseJudgment carry-forward: always feed the parsed value OR
      // the safe on_task fallback into the score machine — a malformed
      // response is NEVER an off-task event.
      const parsed = parseJudgment(content)
      const judgment = parsed.ok ? parsed.value : parsed.fallback
      useFocusStore.getState().applyJudgment(judgment, runtime.now())
    } catch (err) {
      if (err instanceof CaptureError) {
        if (err.code === 'screen_capture_denied') {
          // Latch and bail — V2-P9's ScreenCapturePermissionOverlay handles
          // the re-grant; the loop only resumes after a fresh start().
          state.captureDenied = true
          opts.onCaptureDenied?.()
          return
        }
        opts.onCaptureError?.(err)
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
      schedule(state.sampleIntervalSec * 1000)
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

    // Read measured cadence from the model store. The V2-P2 benchmark sets
    // sampleIntervalSec; if the user hasn't benchmarked yet (or the record
    // was forgotten), the fallback floor keeps the loop ticking but logs.
    const interval =
      useModelStore.getState().records[opts.modelId]?.benchmark
        ?.sampleIntervalSec
    if (
      typeof interval === 'number' &&
      interval >= FALLBACK_SAMPLE_INTERVAL_SEC
    ) {
      state.sampleIntervalSec = interval
    } else {
      console.warn(
        `[sampleLoop] no benchmark for ${opts.modelId}, using fallback ${FALLBACK_SAMPLE_INTERVAL_SEC}s`
      )
      state.sampleIntervalSec = FALLBACK_SAMPLE_INTERVAL_SEC
    }

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
    schedule(state.sampleIntervalSec * 1000)
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

type ChatRequest = {
  model: string
  messages: Array<
    | { role: 'system'; content: string }
    | {
        role: 'user'
        content: Array<
          | { type: 'text'; text: string }
          | { type: 'image_url'; image_url: { url: string } }
        >
      }
  >
  temperature: number
  max_tokens: number
  response_format: { type: 'json_object' }
}

type ChatCompletionResponse = {
  choices?: Array<{
    message?: { content?: string }
    finish_reason?: string
  }>
}

// Matches `tests/ai-eval/run.ts.buildRequest` exactly so eval numbers
// predict runtime behaviour (V2-P4 carry-forward).
function buildChatRequest(args: {
  modelId: string
  topic: string
  faceBase64: string
  screenBase64: string
}): ChatRequest {
  return {
    model: args.modelId,
    messages: [
      { role: 'system', content: FOCUS_SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          { type: 'text', text: `Declared topic: ${args.topic}` },
          {
            type: 'image_url',
            image_url: { url: `data:image/jpeg;base64,${args.faceBase64}` },
          },
          {
            type: 'image_url',
            image_url: {
              url: `data:image/jpeg;base64,${args.screenBase64}`,
            },
          },
        ],
      },
    ],
    temperature: 0,
    max_tokens: 200,
    response_format: { type: 'json_object' },
  }
}

// Re-exported for tests that want to assert specific request shapes.
export const __internals = {
  buildChatRequest,
  BATTERY_PAUSE_PERCENT,
}

// Convenience for any caller that wants the registry severity list without
// importing parseJudgment.
export type { Severity }
