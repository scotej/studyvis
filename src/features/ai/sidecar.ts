// V2-P1 — JS bridge to the llama-server Tauri sidecar.
//
// The wrapper splits responsibility across three pieces:
//   - invoke* helpers that thin-wrap Tauri commands defined in
//     src-tauri/src/commands/sidecar.rs.
//   - useSidecarStore (Zustand) holding the running/port/model/health state
//     so React components can subscribe.
//   - startHealthPoll / stopHealthPoll, which run a 2s loop against the
//     llama-server /health endpoint while the sidecar is alive and update the
//     store's `healthy` flag.
//
// Live AI stays gated by Settings. The fixed local benchmark may start the
// sidecar while that gate is off so users can measure a model before deciding
// whether to enable capture and scoring.

import { invoke } from '@tauri-apps/api/core'
import { create } from 'zustand'

import { logger } from '@/lib/log'
import { useSettingsStore } from '@/stores/settingsStore'
import {
  isAiHardwareIdentity,
  setCurrentAiHardwareIdentity,
  type AiHardwareIdentity,
} from './computeDevice'

const log = logger.child('ai.sidecar')

export type SidecarStatus = {
  running: boolean
  // True while sidecar_start is installing/resolving/spawning, before a child
  // and port exist. Distinguishes an early cold start from an explicit stop.
  starting: boolean
  port: number | null
  model: string | null
  mmproj: string | null
  // snake_case mirrors the Rust struct's serialization (serde default).
  ctx_size: number | null
  errored: boolean
  last_error: string | null
  // Omitted/null means the active child is not safe to associate with a
  // previous benchmark (for example, a crash-restart hardware change).
  hardware_identity?: unknown | null
}

export type SidecarStartPurpose = 'live' | 'benchmark'

type NativeSidecarStartResult = {
  port: number
  hardware_identity: unknown
}

export type SidecarStartResult = {
  port: number
  hardwareIdentity: AiHardwareIdentity | null
}

export const HEALTH_POLL_INTERVAL_MS = 2000
// Cold CPU starts can spend over a minute loading the model and projector.
// Benchmark and agent readiness use the same deadline and retry cadence.
export const SIDECAR_HEALTH_TIMEOUT_MS = 90_000
export const SIDECAR_HEALTH_RETRY_MS = 500

// Indirection so unit tests can substitute the IPC + fetch + setInterval
// without spinning Tauri up. Production wires the defaults below.
export type SidecarRuntime = {
  start: (params: {
    modelPath: string
    mmprojPath: string | null
    ctxSize: number
    engineAutoInstall: boolean
  }) => Promise<SidecarStartResult>
  stop: () => Promise<void>
  status: () => Promise<SidecarStatus>
  fetchHealth: (port: number) => Promise<boolean>
  setInterval: (handler: () => void, ms: number) => unknown
  clearInterval: (handle: unknown) => void
  getAiFeaturesEnabled: () => boolean
  getEngineAutoInstall: () => boolean
}

async function defaultStart(params: {
  modelPath: string
  mmprojPath: string | null
  ctxSize: number
  engineAutoInstall: boolean
}): Promise<SidecarStartResult> {
  const result = await invoke<NativeSidecarStartResult>('sidecar_start', {
    modelPath: params.modelPath,
    mmprojPath: params.mmprojPath ?? null,
    ctxSize: params.ctxSize,
    engineAutoInstall: params.engineAutoInstall,
  })
  if (
    !Number.isInteger(result.port) ||
    result.port <= 0 ||
    result.port > 65535
  ) {
    throw new Error('sidecar_start returned an invalid port')
  }
  return {
    port: result.port,
    hardwareIdentity: isAiHardwareIdentity(result.hardware_identity)
      ? result.hardware_identity
      : null,
  }
}

async function defaultStop(): Promise<void> {
  await invoke('sidecar_stop')
}

async function defaultStatus(): Promise<SidecarStatus> {
  return invoke<SidecarStatus>('sidecar_status')
}

async function defaultFetchHealth(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      method: 'GET',
    })
    if (!res.ok) return false
    // llama-server's /health returns either {status:"ok"} or 503 while loading;
    // accept any 2xx as "healthy enough".
    return true
  } catch {
    return false
  }
}

const defaultRuntime: SidecarRuntime = {
  start: defaultStart,
  stop: defaultStop,
  status: defaultStatus,
  fetchHealth: defaultFetchHealth,
  setInterval: (handler, ms) =>
    typeof window === 'undefined'
      ? globalThis.setInterval(handler, ms)
      : window.setInterval(handler, ms),
  clearInterval: (handle) => {
    if (typeof window === 'undefined') {
      globalThis.clearInterval(handle as ReturnType<typeof setInterval>)
    } else {
      window.clearInterval(handle as number)
    }
  },
  getAiFeaturesEnabled: () =>
    useSettingsStore.getState().values.aiFeaturesEnabled,
  getEngineAutoInstall: () =>
    useSettingsStore.getState().values.engineAutoInstall,
}

let activeRuntime: SidecarRuntime = defaultRuntime
// The sidecar is a singleton.  A cold start has no port until the native
// command returns, so callers that arrive during that interval must join the
// owning request rather than treating `starting + null` as a failed start.
// The first request owns the process configuration; this matches Rust's
// sidecar_start behaviour, which returns the already-started child's port to
// later requests rather than replacing it mid-start.
let inFlightStart: Promise<number | null> | null = null
// A start that races a stop cannot be sent to Rust until the stop command has
// actually completed. Otherwise native command scheduling can run start first,
// have it return the old child's port, and then let the late stop kill the
// child JS just adopted as the new configuration.
let inFlightStop: Promise<void> | null = null
// Monotonic ownership token for async lifecycle continuations. A stop or newer
// start invalidates old start and status-refresh callbacks even when the coarse
// status string has returned to the same value for different work.
let lifecycleGeneration = 0
export function __setSidecarRuntime(runtime: SidecarRuntime): void {
  activeRuntime = runtime
}

export function __resetSidecarRuntime(): void {
  activeRuntime = defaultRuntime
  inFlightStart = null
  inFlightStop = null
}

type SidecarState = {
  status: 'idle' | 'starting' | 'running' | 'stopping' | 'errored'
  port: number | null
  model: string | null
  mmproj: string | null
  ctxSize: number | null
  healthy: boolean
  // ISO timestamp (ms epoch) the most recent health probe completed.
  lastHealthCheckAt: number | null
  lastError: string | null
  pollHandle: unknown | null
  hardwareIdentity: AiHardwareIdentity | null
  start: (params: {
    modelPath: string
    mmprojPath?: string | null
    ctxSize?: number
    purpose?: SidecarStartPurpose
  }) => Promise<number | null>
  stop: () => Promise<void>
  refreshStatus: () => Promise<void>
}

export const DEFAULT_CTX_SIZE = 4096
// A live start while AI features are off refuses with this error. Benchmark
// starts deliberately bypass the live gate.
export const ERR_AI_DISABLED = 'ai_features_disabled'
// The benchmark and live loop share one child process. Requiring the live gate
// to be off prevents a session that starts mid-benchmark from adopting and
// later losing the benchmark's sidecar.
export const ERR_BENCHMARK_REQUIRES_AI_OFF = 'benchmark_requires_ai_off'
// I73 — Rust's sidecar_start rejects with exactly this token when no engine
// binary resolves and auto-install is off. Compare with strict equality (the
// backend rejects with plain strings, never Error instances).
export const ERR_ENGINE_NOT_INSTALLED = 'engine_not_installed'

export const useSidecarStore = create<SidecarState>((set, get) => ({
  status: 'idle',
  port: null,
  model: null,
  mmproj: null,
  ctxSize: null,
  healthy: false,
  lastHealthCheckAt: null,
  lastError: null,
  pollHandle: null,
  hardwareIdentity: null,

  start: async ({
    modelPath,
    mmprojPath = null,
    ctxSize = DEFAULT_CTX_SIZE,
    purpose = 'live',
  }) => {
    // A caller can be refused by its own gate while another consumer owns a
    // live start. Do not reset that unrelated state to idle: doing so would
    // make the owner's successful native response look superseded.
    const refuseStart = (reason: string): void => {
      const status = get().status
      set(
        status === 'idle' || status === 'errored'
          ? { lastError: reason, status: 'idle' }
          : { lastError: reason }
      )
    }
    const aiEnabled = activeRuntime.getAiFeaturesEnabled()
    if (purpose === 'benchmark' && aiEnabled) {
      log.info('start.skipped', {
        reason: ERR_BENCHMARK_REQUIRES_AI_OFF,
        purpose,
      })
      refuseStart(ERR_BENCHMARK_REQUIRES_AI_OFF)
      return null
    }
    if (purpose !== 'benchmark' && !aiEnabled) {
      log.info('start.skipped', { reason: ERR_AI_DISABLED, purpose })
      refuseStart(ERR_AI_DISABLED)
      return null
    }
    // Keep native `sidecar_stop` and a replacement `sidecar_start` ordered.
    // The state becomes `stopping` before the IPC call settles, but Rust sees
    // an extant child until that call has actually won its lock. Merely letting
    // a start proceed from `stopping` would therefore reuse the old process.
    const pendingStop = inFlightStop
    if (pendingStop !== null) {
      log.debug('start.waiting_for_stop', { status: get().status })
      await pendingStop
      // Re-evaluate gates and join any start another waiting caller created.
      // If stopping failed, do not gamble on whatever native process remains.
      const afterStop = get().status
      if (afterStop === 'errored' || afterStop === 'stopping') {
        log.warn('start.blocked_after_stop', { status: afterStop })
        return null
      }
      return get().start({ modelPath, mmprojPath, ctxSize, purpose })
    }
    const current = get()
    if (current.status === 'running') {
      log.debug('start.reused', { status: current.status })
      return current.port
    }
    if (current.status === 'starting' && inFlightStart !== null) {
      log.debug('start.joined', { status: current.status })
      return inFlightStart
    }
    const ownedStart = (async (): Promise<number | null> => {
      const startedAt = Date.now()
      const requestGeneration = ++lifecycleGeneration
      const engineAutoInstall = activeRuntime.getEngineAutoInstall()
      log.info('start.requested', {
        purpose,
        ctxSize,
        hasProjector: mmprojPath !== null,
        engineAutoInstall,
      })
      set({ status: 'starting', lastError: null })
      try {
        const started = await activeRuntime.start({
          modelPath,
          mmprojPath,
          ctxSize,
          engineAutoInstall,
        })
        // A stop or newer start may have taken ownership while Rust was
        // installing/spawning. Rust's start epoch prevents resurrection; this
        // generation check prevents the stale JS continuation from adopting a
        // newer request's `starting` state.
        if (
          requestGeneration !== lifecycleGeneration ||
          get().status !== 'starting'
        ) {
          log.warn('start.superseded', {
            elapsedMs: Date.now() - startedAt,
            currentStatus: get().status,
          })
          return null
        }
        const { port, hardwareIdentity } = started
        set({
          status: 'running',
          port,
          model: modelPath,
          mmproj: mmprojPath,
          ctxSize,
          healthy: false,
          lastError: null,
          hardwareIdentity,
        })
        // Apply a native identity only after this generation still owns the
        // lifecycle state. A late successful old start must not overwrite a
        // newer Auto/eGPU topology after stop or replacement work wins.
        setCurrentAiHardwareIdentity(hardwareIdentity)
        log.info('start.succeeded', {
          purpose,
          elapsedMs: Date.now() - startedAt,
          ctxSize,
          hasProjector: mmprojPath !== null,
        })
        ensurePollingStarted()
        return port
      } catch (err) {
        // A stop/model change may have canceled Rust's still-installing start.
        // Its eventual "superseded" rejection belongs to that stale attempt;
        // do not overwrite the newer idle/stopping/running state with errored.
        if (
          requestGeneration !== lifecycleGeneration ||
          get().status !== 'starting'
        ) {
          log.info('start_failed.superseded', {
            elapsedMs: Date.now() - startedAt,
            currentStatus: get().status,
          })
          return null
        }
        const message = err instanceof Error ? err.message : String(err)
        set({ status: 'errored', lastError: message })
        stopPolling()
        log.error('start.failed', {
          purpose,
          elapsedMs: Date.now() - startedAt,
          ctxSize,
          hasProjector: mmprojPath !== null,
          err,
        })
        return null
      }
    })()
    inFlightStart = ownedStart
    void ownedStart.then(
      () => {
        if (inFlightStart === ownedStart) inFlightStart = null
      },
      () => {
        if (inFlightStart === ownedStart) inFlightStart = null
      }
    )
    return ownedStart
  },

  stop: () => {
    if (inFlightStop !== null) {
      log.debug('stop.joined', { status: get().status })
      return inFlightStop
    }
    if (get().status === 'idle') {
      log.debug('stop.skipped', { status: get().status })
      return Promise.resolve()
    }
    const ownedStop = (async (): Promise<void> => {
      const startedAt = Date.now()
      const previousStatus = get().status
      lifecycleGeneration += 1
      log.info('stop.requested', { previousStatus })
      set({ status: 'stopping' })
      stopPolling()
      try {
        await activeRuntime.stop()
        if (get().status !== 'stopping') {
          log.info('stop.superseded', {
            elapsedMs: Date.now() - startedAt,
            currentStatus: get().status,
          })
          return
        }
        set({
          status: 'idle',
          port: null,
          model: null,
          mmproj: null,
          ctxSize: null,
          healthy: false,
          lastHealthCheckAt: null,
          lastError: null,
          hardwareIdentity: null,
        })
        log.info('stop.succeeded', { elapsedMs: Date.now() - startedAt })
      } catch (err) {
        if (get().status !== 'stopping') {
          log.warn('stop_failed.superseded', {
            elapsedMs: Date.now() - startedAt,
            currentStatus: get().status,
            err,
          })
          return
        }
        const message = err instanceof Error ? err.message : String(err)
        set({ status: 'errored', lastError: message })
        log.error('stop.failed', {
          elapsedMs: Date.now() - startedAt,
          previousStatus,
          err,
        })
      }
    })()
    inFlightStop = ownedStop
    void ownedStop.then(
      () => {
        if (inFlightStop === ownedStop) inFlightStop = null
      },
      () => {
        if (inFlightStop === ownedStop) inFlightStop = null
      }
    )
    return ownedStop
  },

  refreshStatus: async () => {
    const before = get()
    const requestGeneration = lifecycleGeneration
    const resultIsStale = (): boolean => {
      const current = get()
      return (
        requestGeneration !== lifecycleGeneration ||
        current.status !== before.status ||
        inFlightStart !== null ||
        inFlightStop !== null
      )
    }
    try {
      const status = await activeRuntime.status()
      // The native snapshot may have been taken before an overlapping start
      // or stop acquired the singleton. Never let that stale result revoke the
      // transition and make a replacement adopt a port the stop just killed.
      if (resultIsStale()) {
        log.debug('status.refresh_superseded', {
          from: before.status,
          currentStatus: get().status,
        })
        return
      }
      const nextStatus = status.errored
        ? 'errored'
        : status.running
          ? 'running'
          : status.starting
            ? 'starting'
            : 'idle'
      const hardwareIdentity = isAiHardwareIdentity(status.hardware_identity)
        ? status.hardware_identity
        : null
      set((s) => ({
        ...s,
        status: nextStatus,
        port: status.port,
        model: status.model,
        mmproj: status.mmproj,
        ctxSize: status.ctx_size,
        lastError: status.last_error,
        hardwareIdentity,
      }))
      // A renderer reload can recover a still-running native child only from
      // this authoritative snapshot. Conversely, a crash-restart refusal
      // sends null here so stale eGPU timings stop reading as current.
      if (status.running || status.model !== null || status.errored) {
        setCurrentAiHardwareIdentity(hardwareIdentity)
      }
      if (
        before.status !== nextStatus ||
        before.ctxSize !== status.ctx_size ||
        (before.lastError === null) !== (status.last_error === null)
      ) {
        log.info('status.changed', {
          from: before.status,
          to: nextStatus,
          ctxSize: status.ctx_size,
          hasError: status.last_error !== null,
        })
      }
      if (status.running && get().pollHandle === null) {
        ensurePollingStarted()
      }
      if (!status.running && get().pollHandle !== null) {
        stopPolling()
      }
    } catch (err) {
      if (resultIsStale()) return
      const message = err instanceof Error ? err.message : String(err)
      set({ lastError: message })
      log.warn('status.refresh_failed', { previousStatus: before.status, err })
    }
  },
}))

function ensurePollingStarted(): void {
  const state = useSidecarStore.getState()
  if (state.pollHandle !== null) return
  const tick = () => {
    const cur = useSidecarStore.getState()
    if (cur.port == null || cur.status !== 'running') {
      stopPolling()
      return
    }
    const probedPort = cur.port
    const probeStartedAt = Date.now()
    void activeRuntime
      .fetchHealth(probedPort)
      .then((healthy) => {
        // Re-check the store before writing: if the user called stop() (or the
        // sidecar respawned on a new port) while this fetch was in flight, our
        // probe is stale and shouldn't flip `healthy=true` on a dead port.
        const after = useSidecarStore.getState()
        if (after.status !== 'running' || after.port !== probedPort) return
        if (after.healthy !== healthy) {
          log.info('health.changed', {
            healthy,
            probeMs: Date.now() - probeStartedAt,
          })
        }
        useSidecarStore.setState({
          healthy,
          lastHealthCheckAt: Date.now(),
        })
      })
      .catch((err) => {
        const after = useSidecarStore.getState()
        if (after.status !== 'running' || after.port !== probedPort) return
        log.warn('health.probe_failed', {
          probeMs: Date.now() - probeStartedAt,
          err,
        })
        useSidecarStore.setState({
          healthy: false,
          lastHealthCheckAt: Date.now(),
        })
      })
  }
  const handle = activeRuntime.setInterval(tick, HEALTH_POLL_INTERVAL_MS)
  useSidecarStore.setState({ pollHandle: handle })
  // Fire one probe synchronously so the first 2s isn't always reported as
  // unhealthy on a freshly-started server.
  tick()
}

function stopPolling(): void {
  const handle = useSidecarStore.getState().pollHandle
  if (handle === null) return
  activeRuntime.clearInterval(handle)
  useSidecarStore.setState({ pollHandle: null, healthy: false })
}

export const __testInternals = {
  ensurePollingStarted,
  stopPolling,
}
