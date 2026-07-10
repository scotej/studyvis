// JS bridge for `src-tauri/src/commands/models.rs`. Mirrors the
// runtime-injection pattern in ai/sidecar.ts so unit tests + Storybook can
// substitute a fake without spinning Tauri up.

import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

import { modelDownloadUrls, type ModelSpec } from './models'

export type ModelFileKind = 'model' | 'mmproj'

export type ProgressPhase =
  | 'downloading'
  | 'verifying'
  | 'done'
  | 'failed'
  | 'cancelled'

export type ProgressEvent = {
  model_id: string
  // The Rust side emits 'all' for the terminal events; per-file events use
  // the kind label.
  file: ModelFileKind | 'all'
  file_index: number
  file_count: number
  bytes_received: number
  total_bytes: number
  phase: ProgressPhase
  error: string | null
}

export type ModelFileState = { exists: boolean; size: number }
export type ModelInstallState = {
  model: ModelFileState
  mmproj: ModelFileState
}

export type ModelPaths = {
  dir: string
  model_path: string
  mmproj_path: string
}

export type HeadResult = {
  status: number
  content_length: number | null
}

export type DownloadFileRequest = {
  url: string
  size_bytes: number
  sha256_hex: string
  kind: ModelFileKind
}

export type DownloadRuntime = {
  paths: (modelId: string) => Promise<ModelPaths>
  installState: (modelId: string) => Promise<ModelInstallState>
  remove: (modelId: string) => Promise<void>
  headCheck: (url: string, withToken: boolean) => Promise<HeadResult>
  startDownload: (
    modelId: string,
    files: DownloadFileRequest[],
    useToken: boolean
  ) => Promise<void>
  cancelDownload: (modelId: string) => Promise<void>
  subscribeProgress: (
    handler: (e: ProgressEvent) => void
  ) => Promise<UnlistenFn>
}

const PROGRESS_EVENT_NAME = 'model:progress'

const defaultRuntime: DownloadRuntime = {
  paths: (modelId) => invoke<ModelPaths>('model_paths', { modelId }),
  installState: (modelId) =>
    invoke<ModelInstallState>('model_install_state', { modelId }),
  remove: (modelId) => invoke<void>('model_remove', { modelId }),
  headCheck: (url, withToken) =>
    invoke<HeadResult>('model_head_check', { url, withToken }),
  startDownload: (modelId, files, useToken) =>
    invoke<void>('model_download', { modelId, files, useToken }),
  cancelDownload: (modelId) =>
    invoke<void>('model_download_cancel', { modelId }),
  subscribeProgress: (handler) =>
    listen<ProgressEvent>(PROGRESS_EVENT_NAME, (evt) => handler(evt.payload)),
}

let activeRuntime: DownloadRuntime = defaultRuntime

export function __setDownloadRuntime(runtime: DownloadRuntime): void {
  activeRuntime = runtime
}

export function __resetDownloadRuntime(): void {
  activeRuntime = defaultRuntime
}

export function getDownloadRuntime(): DownloadRuntime {
  return activeRuntime
}

export function specToFileRequests(spec: ModelSpec): DownloadFileRequest[] {
  // #47 D3 — resolve at the manifest's pinned revision (via modelDownloadUrls),
  // never `main`: an upstream re-upload would fail the sha256 gate on every
  // new install of the tier until a release refreshed the manifest.
  const urls = modelDownloadUrls(spec)
  return [
    {
      url: urls.model,
      size_bytes: spec.modelFile.sizeBytes,
      sha256_hex: spec.modelFile.sha256,
      kind: 'model',
    },
    {
      url: urls.mmproj,
      size_bytes: spec.mmprojFile.sizeBytes,
      sha256_hex: spec.mmprojFile.sha256,
      kind: 'mmproj',
    },
  ]
}
