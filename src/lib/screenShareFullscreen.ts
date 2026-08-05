export type ScreenShareFullscreenRuntime = {
  enter: () => Promise<void>
  exit: () => Promise<void>
  isActive: () => Promise<boolean>
  onChange: (handler: () => void) => Promise<() => void>
}

export type ScreenShareFullscreenController = {
  open: () => Promise<void>
  close: () => Promise<void>
}

export function createScreenShareFullscreenController(
  runtime: ScreenShareFullscreenRuntime,
  onExited: () => void
): ScreenShareFullscreenController {
  let active = false
  let entering = false
  let disposed = false
  let unlisten: (() => void) | null = null

  const handleChange = async () => {
    if (!active || entering || disposed) return
    try {
      if (!(await runtime.isActive())) {
        active = false
        onExited()
      }
    } catch {
      // A transient window-query failure must not close the viewer.
    }
  }

  return {
    async open() {
      if (active || entering || disposed) return
      entering = true
      try {
        await runtime.enter()
        if (disposed) {
          await runtime.exit().catch(() => {})
          return
        }
        active = true
        unlisten = await runtime.onChange(() => {
          void handleChange()
        })
      } finally {
        entering = false
      }
    },

    async close() {
      if (disposed) return
      disposed = true
      unlisten?.()
      unlisten = null
      if (active || entering) {
        await runtime.exit().catch(() => {})
      }
      active = false
    },
  }
}

export async function createNativeScreenShareFullscreenRuntime(): Promise<ScreenShareFullscreenRuntime> {
  const { getCurrentWindow } = await import('@tauri-apps/api/window')
  const window = getCurrentWindow()
  return {
    enter: () => window.setFullscreen(true),
    exit: () => window.setFullscreen(false),
    isActive: () => window.isFullscreen(),
    onChange: (handler) => window.onResized(handler),
  }
}
