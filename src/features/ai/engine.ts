// JS bridge for `src-tauri/src/commands/engine.rs` (I73 engine
// auto-install). Mirrors the runtime-injection pattern in ai/download.ts so
// unit tests + Storybook can substitute a fake without spinning Tauri up.

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

export function __setEngineRuntime(runtime: EngineRuntime): void {
  activeRuntime = runtime
}

export function __resetEngineRuntime(): void {
  activeRuntime = defaultRuntime
}

export function getEngineRuntime(): EngineRuntime {
  return activeRuntime
}
