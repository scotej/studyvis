// JS bridge for `src-tauri/src/commands/engine.rs` (I73 engine
// auto-install). Mirrors the runtime-injection pattern in ai/download.ts so
// unit tests + Storybook can substitute a fake without spinning Tauri up.

import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

export type EngineSource = 'bundled' | 'managed'

export type EngineInfo = {
  supported: boolean
  installed: boolean
  source: EngineSource | null
  version: string
  installing: boolean
  last_error: string | null
}

export type EnginePhase =
  | 'downloading'
  | 'verifying'
  | 'extracting'
  | 'done'
  | 'failed'

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
  info: () => invoke<EngineInfo>('engine_info'),
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
