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

const STATE_QUERY_RETRY_MS = 100

export function createScreenShareFullscreenController(
  runtime: ScreenShareFullscreenRuntime,
  onExited: () => void
): ScreenShareFullscreenController {
  let disposed = false
  let monitoring = false
  let enteredByController = false
  let unlisten: (() => void) | null = null
  let openPromise: Promise<void> | null = null
  let closePromise: Promise<void> | null = null
  let checkInFlight = false
  let checkQueued = false
  let retryTimer: ReturnType<typeof setTimeout> | null = null

  function clearRetry() {
    if (retryTimer === null) return
    clearTimeout(retryTimer)
    retryTimer = null
  }

  function removeListener() {
    const remove = unlisten
    unlisten = null
    remove?.()
  }

  function scheduleRetry() {
    if (disposed || !monitoring || retryTimer !== null) return
    retryTimer = setTimeout(() => {
      retryTimer = null
      scheduleCheck()
    }, STATE_QUERY_RETRY_MS)
  }

  function scheduleCheck() {
    if (disposed || !monitoring) return
    if (checkInFlight) {
      checkQueued = true
      return
    }
    void runCheck()
  }

  async function runCheck() {
    checkInFlight = true
    try {
      const active = await runtime.isActive()
      if (disposed || !monitoring) return
      clearRetry()
      if (!active) {
        monitoring = false
        checkQueued = false
        onExited()
      }
    } catch {
      scheduleRetry()
    } finally {
      checkInFlight = false
      if (checkQueued && !disposed && monitoring) {
        checkQueued = false
        queueMicrotask(scheduleCheck)
      }
    }
  }

  return {
    open() {
      if (disposed) return Promise.resolve()
      if (openPromise) return openPromise

      openPromise = (async () => {
        const initiallyActive = await runtime.isActive()
        if (disposed) return

        const removeListener = await runtime.onChange(scheduleCheck)
        if (disposed) {
          removeListener()
          return
        }
        unlisten = removeListener

        if (initiallyActive) {
          monitoring = true
          return
        }

        await runtime.enter()
        enteredByController = true
        if (!disposed) monitoring = true
      })()

      return openPromise
    },

    close() {
      if (closePromise) return closePromise
      disposed = true
      monitoring = false
      checkQueued = false
      clearRetry()
      removeListener()

      closePromise = (async () => {
        await openPromise?.catch(() => {})
        removeListener()
        if (enteredByController) {
          enteredByController = false
          await runtime.exit().catch(() => {})
        }
      })()

      return closePromise
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
