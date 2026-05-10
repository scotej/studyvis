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
// AI feature gate: until the user enables AI features in Settings (V2-P9),
// startSidecar is a no-op. The gate is read from useSettingsStore.values
// .aiFeaturesEnabled — this PR adds the field with default `false`; V2-P9
// adds the toggle UI and setter.

import { invoke } from '@tauri-apps/api/core'
import { create } from 'zustand'

import { useSettingsStore } from '@/stores/settingsStore'

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

export const HEALTH_POLL_INTERVAL_MS = 2000

// Indirection so unit tests can substitute the IPC + fetch + setInterval
// without spinning Tauri up. Production wires the defaults below.
export type SidecarRuntime = {
  start: (params: {
    modelPath: string
    mmprojPath: string | null
    ctxSize: number
  }) => Promise<number>
  stop: () => Promise<void>
  status: () => Promise<SidecarStatus>
  fetchHealth: (port: number) => Promise<boolean>
  setInterval: (handler: () => void, ms: number) => unknown
  clearInterval: (handle: unknown) => void
  getAiFeaturesEnabled: () => boolean
}

async function defaultStart(params: {
  modelPath: string
  mmprojPath: string | null
  ctxSize: number
}): Promise<number> {
  return invoke<number>('sidecar_start', {
    modelPath: params.modelPath,
    mmprojPath: params.mmprojPath ?? null,
    ctxSize: params.ctxSize,
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
  }) => Promise<number | null>
  stop: () => Promise<void>
  refreshStatus: () => Promise<void>
}

export const DEFAULT_CTX_SIZE = 4096
// AI features off → start refuses with this error. Surfaced via the store's
// `lastError` so the caller can show a "Enable AI in Settings" hint without
// needing to read settings state itself.
export const ERR_AI_DISABLED = 'ai_features_disabled'

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
  }) => {
    if (!activeRuntime.getAiFeaturesEnabled()) {
      set({ lastError: ERR_AI_DISABLED, status: 'idle' })
      return null
    }
    if (get().status === 'running' || get().status === 'starting') {
      return get().port
    }
    set({ status: 'starting', lastError: null })
    try {
      const port = await activeRuntime.start({ modelPath, mmprojPath, ctxSize })
      set({
        status: 'running',
        port,
        model: modelPath,
        mmproj: mmprojPath,
        ctxSize,
        healthy: false,
        lastError: null,
      })
      ensurePollingStarted()
      return port
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      set({ status: 'errored', lastError: message })
      stopPolling()
      return null
    }
  },

  stop: async () => {
    if (get().status === 'idle' || get().status === 'stopping') return
    set({ status: 'stopping' })
    stopPolling()
    try {
      await activeRuntime.stop()
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
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      set({ status: 'errored', lastError: message })
    }
  },

  refreshStatus: async () => {
    try {
      const status = await activeRuntime.status()
      set((s) => ({
        ...s,
        status: status.errored
          ? 'errored'
          : status.running
            ? 'running'
            : 'idle',
        port: status.port,
        model: status.model,
        mmproj: status.mmproj,
        ctxSize: status.ctx_size,
        lastError: status.last_error,
      }))
      if (status.running && get().pollHandle === null) {
        ensurePollingStarted()
      }
      if (!status.running && get().pollHandle !== null) {
        stopPolling()
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      set({ lastError: message })
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
    void activeRuntime.fetchHealth(probedPort).then((healthy) => {
      // Re-check the store before writing: if the user called stop() (or the
      // sidecar respawned on a new port) while this fetch was in flight, our
      // probe is stale and shouldn't flip `healthy=true` on a dead port.
      const after = useSidecarStore.getState()
      if (after.status !== 'running' || after.port !== probedPort) return
      useSidecarStore.setState({
        healthy,
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
