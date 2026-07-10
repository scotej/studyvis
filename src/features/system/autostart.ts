// Thin bridge to the Rust autostart commands (tauri-plugin-autostart).
// Tauri-only — callers go through useAutostart, which reports 'unavailable'
// outside the desktop runtime.

import { invoke } from '@tauri-apps/api/core'

export async function setAutostartEnabled(enabled: boolean): Promise<void> {
  await invoke('autostart_set_enabled', { enabled })
}

export async function getAutostartEnabled(): Promise<boolean> {
  return await invoke<boolean>('autostart_is_enabled')
}
