// JS bridge for `src-tauri/src/commands/engine.rs` (I73 engine
// auto-install). Mirrors the runtime-injection pattern in ai/download.ts so
// unit tests + Storybook can substitute a fake without spinning Tauri up.

import { useEffect } from 'react'
import { create } from 'zustand'

import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

import {
  setCurrentAiHardwareIdentity,
  type AiHardwareIdentity,
} from './computeDevice'

export type EngineSource = 'bundled' | 'managed'

export type EngineDevice = {
  id: string
  label: string
}

export type EngineInfo = {
  supported: boolean
  support_error?: 'macos_ai_requires_14' | null
  installed: boolean
  source: EngineSource | null
  version: string
  installing: boolean
  last_error: string | null
  devices: EngineDevice[]
  device_error: string | null
  hardware_identity: AiHardwareIdentity
}

export type EnginePhase =
  'downloading' | 'verifying' | 'extracting' | 'done' | 'failed'

export type EngineProgressEvent = {
  phase: EnginePhase
  bytes_received: number
  total_bytes: number
  error: string | null
}

export type EngineRuntime = {
  info: () => Promise<EngineInfo>
  install: () => Promise<void>
  subscribeProgress: (
    handler: (e: EngineProgressEvent) => void
  ) => Promise<UnlistenFn>
}

const PROGRESS_EVENT_NAME = 'engine:progress'
export const ENGINE_INFO_TIMEOUT_MS = 10_000

const defaultRuntime: EngineRuntime = {
  info: async () => {
    const info = await invoke<EngineInfo>('engine_info')
    // Native engine_info reads the canonical Tauri store plus its resolved
    // accelerator topology. This is the only renderer-side source allowed to
    // make a persisted benchmark current.
    setCurrentAiHardwareIdentity(info.hardware_identity)
    return info
  },
  install: () => invoke<void>('engine_install'),
  subscribeProgress: (handler) =>
    listen<EngineProgressEvent>(PROGRESS_EVENT_NAME, (evt) =>
      handler(evt.payload)
    ),
}

let activeRuntime: EngineRuntime = defaultRuntime

const usePlatformSupport = create<{
  supported: boolean | null
  status: 'idle' | 'loading' | 'ready' | 'error'
}>(() => ({ supported: null, status: 'idle' }))
let supportGeneration = 0
let pendingInfo: Promise<EngineInfo> | null = null

function resetPlatformSupport(): void {
  supportGeneration += 1
  pendingInfo = null
  usePlatformSupport.setState({ supported: null, status: 'idle' })
}

// Read support before a capture gesture, rather than awaiting native I/O in
// the gesture handler. Unknown and failed observations never authorize AI.
export function readEngineInfo(): Promise<EngineInfo> {
  if (pendingInfo) return pendingInfo
  const generation = ++supportGeneration
  const runtime = activeRuntime
  usePlatformSupport.setState({ status: 'loading' })
  let timer: ReturnType<typeof setTimeout> | undefined
  const request = Promise.race([
    Promise.resolve().then(() => runtime.info()),
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error('engine_info_timeout')),
        ENGINE_INFO_TIMEOUT_MS
      )
    }),
  ])
    .then((info) => {
      if (generation === supportGeneration) {
        usePlatformSupport.setState({
          supported: info.supported,
          status: 'ready',
        })
      }
      return info
    })
    .catch((error: unknown) => {
      if (generation === supportGeneration) {
        usePlatformSupport.setState({ supported: null, status: 'error' })
      }
      throw error
    })
    .finally(() => {
      clearTimeout(timer)
      if (generation === supportGeneration) pendingInfo = null
    })
  pendingInfo = request
  return request
}

export function getAiPlatformSupported(): boolean {
  return usePlatformSupport.getState().supported === true
}

export function isAiPlatformSupportPending(): boolean {
  const state = usePlatformSupport.getState()
  return (
    state.supported === null &&
    (state.status === 'idle' || state.status === 'loading')
  )
}

export function useAiPlatformSupported(enabled = true): boolean | null {
  const supported = usePlatformSupport((state) => state.supported)
  const status = usePlatformSupport((state) => state.status)
  useEffect(() => {
    if (enabled && status === 'idle') void readEngineInfo().catch(() => {})
  }, [enabled, status])
  return status === 'error' ? false : supported
}

export function __setEngineRuntime(runtime: EngineRuntime): void {
  activeRuntime = runtime
  resetPlatformSupport()
}

export function __resetEngineRuntime(): void {
  activeRuntime = defaultRuntime
  resetPlatformSupport()
}

export function getEngineRuntime(): EngineRuntime {
  return activeRuntime
}
