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

const log = logger.child('ai.sidecar')

export type SidecarStatus = {
  running: boolean
  port: number | null
  model: string | null
  mmproj: string | null
  // snake_case mirrors the Rust struct's serialization (serde default).
  ctx_size: number | null
  errored: boolean
  last_error: string | null
}

export type SidecarStartPurpose = 'live' | 'benchmark'

export const HEALTH_POLL_INTERVAL_MS = 2000

// Indirection so unit tests can substitute the IPC + fetch + setInterval
// without spinning Tauri up. Production wires the defaults below.
export type SidecarRuntime = {
  start: (params: {
    modelPath: string
    mmprojPath: string | null
    ctxSize: number
    engineAutoInstall: boolean
  }) => Promise<number>
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
}): Promise<number> {
  return invoke<number>('sidecar_start', {
    modelPath: params.modelPath,
    mmprojPath: params.mmprojPath ?? null,
    ctxSize: params.ctxSize,
    engineAutoInstall: params.engineAutoInstall,
  })
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

export function __setSidecarRuntime(runtime: SidecarRuntime): void {
  activeRuntime = runtime
}

export function __resetSidecarRuntime(): void {
  activeRuntime = defaultRuntime
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

  start: async ({
    modelPath,
    mmprojPath = null,
    ctxSize = DEFAULT_CTX_SIZE,
    purpose = 'live',
  }) => {
    const aiEnabled = activeRuntime.getAiFeaturesEnabled()
    if (purpose === 'benchmark' && aiEnabled) {
      log.info('start.skipped', {
        reason: ERR_BENCHMARK_REQUIRES_AI_OFF,
        purpose,
      })
      set({ lastError: ERR_BENCHMARK_REQUIRES_AI_OFF, status: 'idle' })
      return null
    }
    if (purpose !== 'benchmark' && !aiEnabled) {
      log.info('start.skipped', { reason: ERR_AI_DISABLED, purpose })
      set({ lastError: ERR_AI_DISABLED, status: 'idle' })
      return null
    }
    if (get().status === 'running' || get().status === 'starting') {
      log.debug('start.reused', { status: get().status })
      return get().port
    }
    const startedAt = Date.now()
    const engineAutoInstall = activeRuntime.getEngineAutoInstall()
    log.info('start.requested', {
      purpose,
      ctxSize,
      hasProjector: mmprojPath !== null,
      engineAutoInstall,
    })
    set({ status: 'starting', lastError: null })
    try {
      const port = await activeRuntime.start({
        modelPath,
        mmprojPath,
        ctxSize,
        engineAutoInstall,
      })
      // PR-13 — a stop() may have run while we awaited (session teardown, a
      // localStream re-acquire, or a model change firing the sample-loop effect
      // cleanup). It would have transitioned us out of 'starting'; don't clobber
      // that back to 'running' with a port whose process the interleaved stop
      // already killed. Tear down what we just started and bail.
      if (get().status !== 'starting') {
        log.warn('start.superseded', {
          elapsedMs: Date.now() - startedAt,
          currentStatus: get().status,
        })
        await activeRuntime.stop().catch((err) => {
          log.warn('superseded_stop.failed', { err })
        })
        return null
      }
      set({
        status: 'running',
        port,
        model: modelPath,
        mmproj: mmprojPath,
        ctxSize,
        healthy: false,
        lastError: null,
      })
      log.info('start.succeeded', {
        purpose,
        elapsedMs: Date.now() - startedAt,
        ctxSize,
        hasProjector: mmprojPath !== null,
      })
      ensurePollingStarted()
      return port
    } catch (err) {
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
  },

  stop: async () => {
    if (get().status === 'idle' || get().status === 'stopping') {
      log.debug('stop.skipped', { status: get().status })
      return
    }
    const startedAt = Date.now()
    const previousStatus = get().status
    log.info('stop.requested', { previousStatus })
    set({ status: 'stopping' })
    stopPolling()
    try {
      await activeRuntime.stop()
      // Mirror of the PR-13 guard in start(): a newer start() may have run
      // while we awaited (the sample-loop effect tears the old loop down and
      // boots a new one in the same React commit on a localStream swap). Once
      // it wrote 'starting' it owns the state machine — writing 'idle' here
      // would make its own PR-13 guard kill the child it just spawned and
      // toast "AI failed to start". The Rust side is already consistent:
      // sidecar_stop killed the old child before sidecar_start spawned the
      // new one.
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
  },

  refreshStatus: async () => {
    const before = get()
    try {
      const status = await activeRuntime.status()
      const nextStatus = status.errored
        ? 'errored'
        : status.running
          ? 'running'
          : 'idle'
      set((s) => ({
        ...s,
        status: nextStatus,
        port: status.port,
        model: status.model,
        mmproj: status.mmproj,
        ctxSize: status.ctx_size,
        lastError: status.last_error,
      }))
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
