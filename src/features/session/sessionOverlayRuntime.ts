import { emitTo } from '@tauri-apps/api/event'
import { WebviewWindow } from '@tauri-apps/api/webviewWindow'
import {
  cursorPosition,
  getCurrentWindow,
  monitorFromPoint,
  primaryMonitor,
} from '@tauri-apps/api/window'

import { isMacLikePlatform } from '@/lib/utils'
import { strings } from '@/strings'

import {
  SESSION_OVERLAY_CREATE_TIMEOUT_MS,
  SESSION_OVERLAY_DISMISS,
  SESSION_OVERLAY_QUEUE_CAP,
  SESSION_OVERLAY_READY,
  SESSION_OVERLAY_UPDATE,
  SESSION_OVERLAY_WINDOW_HEIGHT,
  SESSION_OVERLAY_WINDOW_LABEL,
  SESSION_OVERLAY_WINDOW_MARGIN,
  SESSION_OVERLAY_WINDOW_WIDTH,
  SessionOverlayQueue,
  type SessionOverlayItemInput,
} from './sessionOverlay'

const queue = new SessionOverlayQueue(SESSION_OVERLAY_QUEUE_CAP)
let expiryTimer: ReturnType<typeof setTimeout> | null = null
let windowReady = false
let creatingWindow: Promise<WebviewWindow | null> | null = null
let serial: Promise<void> = Promise.resolve()

export function pushSessionOverlayItem(
  input: SessionOverlayItemInput
): Promise<void> {
  return runSerial(async () => {
    if (!(await mainWindowNeedsOverlay())) return
    queue.enqueue(input, Date.now())
    await syncOverlayWindow()
  })
}

export function dismissSessionOverlayItem(id: string): Promise<void> {
  return runSerial(async () => {
    queue.dismiss(id, Date.now())
    await syncOverlayWindow()
  })
}

export function clearSessionOverlay(): Promise<void> {
  return runSerial(async () => {
    queue.clear()
    await syncOverlayWindow()
  })
}

export function markSessionOverlayReady(): Promise<void> {
  return runSerial(async () => {
    windowReady = true
    await syncOverlayWindow()
  })
}

export async function mainWindowNeedsOverlay(): Promise<boolean> {
  if (typeof document === 'undefined') return false
  if (document.visibilityState === 'visible' && document.hasFocus()) {
    return false
  }
  try {
    const mainWindow = getCurrentWindow()
    const [visible, focused] = await Promise.all([
      mainWindow.isVisible(),
      mainWindow.isFocused(),
    ])
    return !visible || !focused
  } catch {
    return false
  }
}

export const sessionOverlayEvents = {
  ready: SESSION_OVERLAY_READY,
  dismiss: SESSION_OVERLAY_DISMISS,
} as const

function runSerial(task: () => Promise<void>): Promise<void> {
  const next = serial.then(task, task)
  serial = next.catch(() => {})
  return next
}

async function syncOverlayWindow(): Promise<void> {
  const now = Date.now()
  const snapshot = queue.snapshot(now)
  scheduleExpiry(snapshot.item?.expiresAt ?? null, now)

  if (!snapshot.item) {
    await closeOverlayWindow()
    return
  }

  const overlayWindow = await ensureOverlayWindow()
  if (!overlayWindow || !windowReady) return

  try {
    await emitTo(
      SESSION_OVERLAY_WINDOW_LABEL,
      SESSION_OVERLAY_UPDATE,
      snapshot
    )
    await overlayWindow.show()
  } catch {
    windowReady = false
  }
}

function scheduleExpiry(expiresAt: number | null, now: number): void {
  if (expiryTimer !== null) {
    clearTimeout(expiryTimer)
    expiryTimer = null
  }
  if (expiresAt === null) return
  expiryTimer = setTimeout(() => {
    expiryTimer = null
    void runSerial(syncOverlayWindow)
  }, Math.max(0, expiresAt - now))
}

async function ensureOverlayWindow(): Promise<WebviewWindow | null> {
  try {
    const existing = await WebviewWindow.getByLabel(
      SESSION_OVERLAY_WINDOW_LABEL
    )
    if (existing) return existing
  } catch {
    return null
  }

  if (creatingWindow) return creatingWindow
  windowReady = false
  creatingWindow = createOverlayWindow().finally(() => {
    creatingWindow = null
  })
  return creatingWindow
}

async function createOverlayWindow(): Promise<WebviewWindow | null> {
  const position = await resolveOverlayPosition()
  const overlayWindow = new WebviewWindow(SESSION_OVERLAY_WINDOW_LABEL, {
    url: 'session-overlay.html',
    title: strings.app.name,
    width: SESSION_OVERLAY_WINDOW_WIDTH,
    height: SESSION_OVERLAY_WINDOW_HEIGHT,
    x: position?.x,
    y: position?.y,
    decorations: false,
    transparent: true,
    acceptFirstMouse: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    focus: false,
    focusable: true,
    resizable: false,
    visible: false,
    visibleOnAllWorkspaces: true,
    preventOverflow: true,
    shadow: !isMacLikePlatform(),
  })

  return new Promise((resolve) => {
    let settled = false
    let timeout: ReturnType<typeof setTimeout> | null = null
    const finish = (result: WebviewWindow | null) => {
      if (settled) return
      settled = true
      if (timeout !== null) clearTimeout(timeout)
      resolve(result)
    }
    timeout = setTimeout(
      () => finish(null),
      SESSION_OVERLAY_CREATE_TIMEOUT_MS
    )
    void overlayWindow.once('tauri://created', () => finish(overlayWindow))
    void overlayWindow.once('tauri://error', () => finish(null))
  })
}

async function resolveOverlayPosition(): Promise<{
  x: number
  y: number
} | null> {
  try {
    const cursor = await cursorPosition()
    const monitor =
      (await monitorFromPoint(cursor.x, cursor.y)) ??
      (await getCurrentWindow().currentMonitor()) ??
      (await primaryMonitor())
    if (!monitor) return null
    const position = monitor.workArea.position.toLogical(monitor.scaleFactor)
    const size = monitor.workArea.size.toLogical(monitor.scaleFactor)
    return {
      x: Math.max(
        position.x,
        position.x +
          size.width -
          SESSION_OVERLAY_WINDOW_WIDTH -
          SESSION_OVERLAY_WINDOW_MARGIN
      ),
      y: position.y + SESSION_OVERLAY_WINDOW_MARGIN,
    }
  } catch {
    return null
  }
}

async function closeOverlayWindow(): Promise<void> {
  if (expiryTimer !== null) {
    clearTimeout(expiryTimer)
    expiryTimer = null
  }
  windowReady = false
  try {
    const overlayWindow =
      (await WebviewWindow.getByLabel(SESSION_OVERLAY_WINDOW_LABEL)) ??
      (await creatingWindow)
    await overlayWindow?.close()
  } catch {
    // The overlay may already have closed itself after receiving an empty queue.
  }
}
