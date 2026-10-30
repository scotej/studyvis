import { invoke, isTauri } from '@tauri-apps/api/core'

let captureActive = false
let nativeCaptureUpdate: Promise<void> = Promise.resolve()

export function isKeybindCaptureActive(): boolean {
  return captureActive
}

export function setShortcutCaptureActive(active: boolean): Promise<void> {
  captureActive = active
  if (!isTauri()) return Promise.resolve()
  nativeCaptureUpdate = nativeCaptureUpdate
    .catch(() => {})
    .then(async () => {
      await invoke('system_set_shortcut_capture_active', {
        active: captureActive,
      })
    })
  return nativeCaptureUpdate
}
