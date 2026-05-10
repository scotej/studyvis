// JS bridge for the keyring-backed Hugging Face token commands. The token
// itself never round-trips through JS after `save`: callers learn whether a
// token exists via `present()`, and the Rust download command reads the
// token from the keyring directly when given `useToken: true`.

import { invoke } from '@tauri-apps/api/core'

export type HfTokenRuntime = {
  save: (token: string) => Promise<void>
  present: () => Promise<boolean>
  clear: () => Promise<void>
}

const defaultRuntime: HfTokenRuntime = {
  save: (token) => invoke<void>('hf_token_save', { token }),
  present: () => invoke<boolean>('hf_token_present'),
  clear: () => invoke<void>('hf_token_clear'),
}

let activeRuntime: HfTokenRuntime = defaultRuntime

export function __setHfTokenRuntime(runtime: HfTokenRuntime): void {
  activeRuntime = runtime
}

export function __resetHfTokenRuntime(): void {
  activeRuntime = defaultRuntime
}

export function getHfTokenRuntime(): HfTokenRuntime {
  return activeRuntime
}
