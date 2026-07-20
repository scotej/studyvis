// Pure logic for the remember-window-layout feature (Settings → Appearance
// → Window). Split from WindowLayoutListener so the capture policy is
// node-testable (`tests/unit/window-layout.test.ts`) without a Tauri
// runtime — same seam layout as `windowChrome.ts` / `useAutostart.ts`.

import { LogicalSize } from '@tauri-apps/api/dpi'
import { getCurrentWindow } from '@tauri-apps/api/window'

import type { WindowLayout } from '@/stores/settingsStore'

// Mirrors `app.windows[0]` in src-tauri/tauri.conf.json (width/height 1280 ×
// 800, logical). There is no shared constant between the conf and either
// runtime today, so keep these three sites in lockstep by hand.
export const DEFAULT_WINDOW_WIDTH = 1280
export const DEFAULT_WINDOW_HEIGHT = 800

export type WindowSnapshot = {
  // Inner size + outer position in physical pixels — the units Tauri's
  // getters report and the persisted `WindowLayout` stores — plus the
  // scale factor they were captured under (see WindowLayout.scaleFactor).
  width: number
  height: number
  x: number
  y: number
  scaleFactor: number
  maximized: boolean
  minimized: boolean
}

// Decides what (if anything) to persist for a snapshot. Returns null when
// nothing should be written:
// - minimized: Windows reports off-screen placeholder geometry (-32000).
// - maximized: only the flag flips — the floating rect keeps its last
//   value so unmaximize-after-relaunch returns to the remembered size. With
//   no prior floating rect there is nothing restorable yet, so skip.
// - unchanged: identical to what's stored; skip the disk write.
export function nextWindowLayout(
  prev: WindowLayout | null,
  snap: WindowSnapshot
): WindowLayout | null {
  if (snap.minimized) return null
  const next: WindowLayout | null = snap.maximized
    ? prev
      ? { ...prev, maximized: true }
      : null
    : {
        width: snap.width,
        height: snap.height,
        x: snap.x,
        y: snap.y,
        scaleFactor: snap.scaleFactor,
        maximized: false,
      }
  if (next === null) return null
  if (prev && windowLayoutsEqual(prev, next)) return null
  return next
}

export function windowLayoutsEqual(a: WindowLayout, b: WindowLayout): boolean {
  return (
    a.width === b.width &&
    a.height === b.height &&
    a.x === b.x &&
    a.y === b.y &&
    a.scaleFactor === b.scaleFactor &&
    a.maximized === b.maximized
  )
}

export function isTauriRuntime(): boolean {
  return (
    typeof window !== 'undefined' &&
    ('__TAURI_INTERNALS__' in window || '__TAURI__' in window)
  )
}

export async function captureWindowSnapshot(): Promise<WindowSnapshot> {
  const w = getCurrentWindow()
  const [size, position, scaleFactor, maximized, minimized] = await Promise.all(
    [
      w.innerSize(),
      w.outerPosition(),
      w.scaleFactor(),
      w.isMaximized(),
      w.isMinimized(),
    ]
  )
  return {
    width: size.width,
    height: size.height,
    x: position.x,
    y: position.y,
    scaleFactor,
    maximized,
    minimized,
  }
}

// Settings → Appearance → Window → Reset. Logical units on purpose: the
// conf minimums/defaults are logical, so the reset lands on the same size
// the first launch had regardless of display scale.
export async function resetWindowToDefault(): Promise<void> {
  if (!isTauriRuntime()) return
  const w = getCurrentWindow()
  if (await w.isMaximized()) await w.unmaximize()
  await w.setSize(new LogicalSize(DEFAULT_WINDOW_WIDTH, DEFAULT_WINDOW_HEIGHT))
  await w.center()
}
