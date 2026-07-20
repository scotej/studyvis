import { useEffect } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'

import { useSettingsStore } from '@/stores/settingsStore'

import {
  captureWindowSnapshot,
  isTauriRuntime,
  nextWindowLayout,
} from './windowLayout'

const CAPTURE_DEBOUNCE_MS = 500

// App-wide observer of the main window's geometry, mounted once in App.tsx
// alongside the other system listeners. While the remember-window-layout
// setting is on, every move/resize is captured (debounced) into the
// settings store; Rust reads the result from settings.json at the next boot
// and restores it before the window is shown. The effect also captures once
// whenever the flag flips on (including mount), so toggling the setting
// re-anchors to the live geometry instead of a stale remembered one.
export function WindowLayoutListener() {
  const remember = useSettingsStore((s) => s.values.rememberWindowLayout)
  const status = useSettingsStore((s) => s.status)

  useEffect(() => {
    // Wait for hydration: before `ready`, `remember` is only the default and
    // a capture could persist under a flag the user actually turned off.
    if (status !== 'ready' || !remember || !isTauriRuntime()) return

    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const capture = async () => {
      try {
        const snap = await captureWindowSnapshot()
        if (disposed) return
        const { values, saveWindowLayout } = useSettingsStore.getState()
        if (!values.rememberWindowLayout) return
        const next = nextWindowLayout(values.windowLayout, snap)
        if (next) void saveWindowLayout(next)
      } catch {
        // Best-effort: a failed getter (window mid-teardown) just skips one
        // capture; the next move/resize schedules another.
      }
    }

    const schedule = () => {
      clearTimeout(timer)
      timer = setTimeout(() => void capture(), CAPTURE_DEBOUNCE_MS)
    }

    // Flush immediately when the window is asked to close: the debounce
    // would otherwise drop a move/resize made in the last half second
    // before quitting. Best-effort — under minimize-to-tray the process
    // survives and the write always lands; on a real quit it races the
    // teardown.
    const flush = () => {
      clearTimeout(timer)
      void capture()
    }

    void capture()
    const w = getCurrentWindow()
    const unlisteners = Promise.all([
      w.onResized(schedule),
      w.onMoved(schedule),
      w.onCloseRequested(flush),
    ])

    return () => {
      disposed = true
      clearTimeout(timer)
      void unlisteners.then((fns) => {
        for (const fn of fns) fn()
      })
    }
  }, [remember, status])

  return null
}
