import { useEffect, useState } from 'react'
import { MinusIcon, SquareIcon, CopyIcon, XIcon } from 'lucide-react'

import {
  detectChromePlatform,
  titleBarHeightPx,
  titleBarLeftInsetPx,
  windowControlOrder,
  type ChromePlatform,
  type WindowControl,
} from '@/lib/windowChrome'
import { cn } from '@/lib/utils'
import { strings } from '@/strings'

// V3-P6 — Custom window chrome titlebar. Renders only when the user has
// opted in (Settings → Appearance → Window style → Custom). DESIGN-SYSTEM
// §15 wordmark on the left, OS-correct controls on the right.
//
// macOS: the OS still owns the traffic-light cluster (we apply
// `TitleBarStyle::Overlay` from Rust, which preserves double-click-zoom,
// fullscreen toggle, snap, and the system-rendered close/min/max). The
// component reserves a left inset for those lights and shows no controls
// of its own.
//
// Windows: the OS chrome is fully off (`set_decorations(false)`); the
// component renders the platform-standard min / restore / close cluster
// on the right.
//
// Drag: a `data-tauri-drag-region` strip sits between the wordmark and the
// control cluster so the user can grab the bar anywhere in the middle.
// The edge gutters (left of wordmark, right of controls) intentionally
// leave a few pixels for the OS resize hit-test on Windows (Aero Snap
// from the top edge keeps working).

export type TitleBarProps = {
  // Test seam: callers can pass a platform explicitly (Storybook, unit
  // smoke tests). Undefined → detect from `navigator.userAgent`.
  platform?: ChromePlatform
  // Optional callback per control. Undefined → invoke the Tauri window
  // API (`getCurrentWindow().minimize()` etc.). Storybook overrides this
  // so the buttons render and animate state without needing a real
  // Tauri runtime.
  onControl?: (control: WindowControl) => void
  // Forces the maximized visual state. Storybook only; the live runtime
  // tracks the real window state via the `tauri://resize` event.
  forceMaximized?: boolean
  className?: string
}

export function TitleBar({
  platform,
  onControl,
  forceMaximized,
  className,
}: TitleBarProps) {
  const detected = platform ?? detectChromePlatform()
  const controls = windowControlOrder(detected)
  const leftInset = titleBarLeftInsetPx(detected)
  const [isMaximized, setIsMaximized] = useState<boolean>(
    forceMaximized ?? false
  )

  // Mirror the live Tauri window's maximized state into local state so
  // the middle (maximize) glyph swaps to "restore" appropriately. The
  // subscription is silently no-op'd in Storybook / non-Tauri (the import
  // succeeds — `@tauri-apps/api/window` is a JS module — but `listen()`
  // throws on the IPC channel; the catch keeps the story usable).
  useEffect(() => {
    if (forceMaximized !== undefined) return
    let cleanup: (() => void) | undefined
    let cancelled = false
    void (async () => {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window')
        const win = getCurrentWindow()
        const initial = await win.isMaximized()
        if (cancelled) return
        setIsMaximized(initial)
        const unlisten = await win.onResized(async () => {
          try {
            const next = await win.isMaximized()
            setIsMaximized(next)
          } catch {
            // ignore — see the outer catch
          }
        })
        // If we unmounted while onResized was in flight, the cleanup below
        // already ran (cleanup was still undefined, a no-op), so tear the
        // listener down here instead of leaking it for the process lifetime.
        if (cancelled) {
          unlisten()
          return
        }
        cleanup = unlisten
      } catch {
        // Not a Tauri runtime (Storybook / vitest): leave the local state
        // at its initial value. The story sets `forceMaximized` directly.
      }
    })()
    return () => {
      cancelled = true
      cleanup?.()
    }
  }, [forceMaximized])

  const handleControl = async (control: WindowControl) => {
    if (onControl) {
      onControl(control)
      return
    }
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window')
      const win = getCurrentWindow()
      if (control === 'minimize') await win.minimize()
      else if (control === 'maximize') await win.toggleMaximize()
      else await win.close()
    } catch (err) {
      console.error(`[titlebar] ${control} failed:`, err)
    }
  }

  return (
    <header
      data-slot="titlebar"
      role="banner"
      aria-label={strings.chrome.titleBar.ariaLabel}
      className={cn(
        'relative flex w-full shrink-0 select-none items-center border-b border-border-subtle bg-bg-base',
        className
      )}
      style={{ height: titleBarHeightPx() }}
    >
      <div
        // Wordmark wrapper is also a drag region so users can grab the
        // titlebar from the left edge (matches macOS native expectation).
        // Tauri's `data-tauri-drag-region` only forwards drag from the
        // exact element — children (the span) don't inherit it, but
        // clicks on whitespace around the text still start the drag.
        data-tauri-drag-region
        className="flex h-full items-center"
        style={{ paddingLeft: leftInset }}
      >
        <span
          className="pointer-events-none text-sm font-semibold tracking-tight text-text-primary"
          // §15 wordmark: lowercase, semibold, letter-spacing tight. No
          // logo glyph here — the menubar / tray surfaces carry the icon,
          // the chrome band carries the word. `pointer-events: none` lets
          // mousedown on the text pass through to the drag-region parent.
        >
          {strings.chrome.titleBar.wordmark}
        </span>
      </div>
      <div
        // Middle filler — the bulk of the draggable surface.
        data-tauri-drag-region
        className="h-full flex-1"
        aria-hidden="true"
      />
      {detected === 'windows' ? (
        <div
          className="flex h-full items-center"
          aria-label={strings.chrome.titleBar.controlsAriaLabel}
        >
          {controls.map((control) => (
            <ControlButton
              key={control}
              control={control}
              isMaximized={isMaximized}
              onActivate={() => void handleControl(control)}
            />
          ))}
        </div>
      ) : null}
    </header>
  )
}

function ControlButton({
  control,
  isMaximized,
  onActivate,
}: {
  control: WindowControl
  isMaximized: boolean
  onActivate: () => void
}) {
  const buttons = strings.chrome.titleBar.buttons
  const label =
    control === 'minimize'
      ? buttons.minimize
      : control === 'maximize'
        ? isMaximized
          ? buttons.restore
          : buttons.maximize
        : buttons.close

  // Close button: subtle by default, alerted (red) only on hover, with
  // text-inverse for legibility. The hover pairing already exists in
  // `scripts/check-contrast.ts` PAIRINGS as `text-inverse on bg-status-alerted`.
  // Minimize/maximize: surface-hover-only with the same idle iconography.
  const isClose = control === 'close'
  const hoverCls = isClose
    ? 'hover:bg-status-alerted hover:text-text-inverse'
    : 'hover:bg-bg-raised'

  return (
    <button
      type="button"
      aria-label={label}
      onClick={onActivate}
      className={cn(
        'flex h-full w-12 items-center justify-center text-text-secondary outline-none transition-colors duration-fast ease-out-token',
        // Match the repo focus-visible convention (SettingsLayout nav
        // buttons, KeybindCapture): accent ring at 3 px width. `ring-inset`
        // keeps the ring inside the button bounds since these sit flush
        // with the window edge — an outset ring would clip against the
        // top/right edges in custom-chrome mode.
        'focus-visible:bg-bg-raised focus-visible:text-text-primary focus-visible:ring-3 focus-visible:ring-inset focus-visible:ring-accent-ring',
        hoverCls
      )}
    >
      <ControlGlyph control={control} isMaximized={isMaximized} />
    </button>
  )
}

function ControlGlyph({
  control,
  isMaximized,
}: {
  control: WindowControl
  isMaximized: boolean
}) {
  // 12-px glyphs; lucide-react ships with 1.5 stroke matching DESIGN-SYSTEM §9.
  if (control === 'minimize') return <MinusIcon size={12} strokeWidth={1.5} />
  if (control === 'close') return <XIcon size={12} strokeWidth={1.5} />
  // maximize / restore
  if (isMaximized) return <CopyIcon size={12} strokeWidth={1.5} />
  return <SquareIcon size={12} strokeWidth={1.5} />
}
