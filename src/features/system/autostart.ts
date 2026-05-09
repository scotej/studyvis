import { invoke } from '@tauri-apps/api/core'

export async function setAutostartEnabled(enabled: boolean): Promise<void> {
  await invoke('autostart_set_enabled', { enabled })
}

export async function getAutostartEnabled(): Promise<boolean> {
  return await invoke<boolean>('autostart_is_enabled')
}
