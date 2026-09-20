import { invoke } from '@tauri-apps/api/core'
import { LogicalPosition, LogicalSize } from '@tauri-apps/api/dpi'
import { emitTo } from '@tauri-apps/api/event'
import {
  getCurrentWebviewWindow,
  WebviewWindow,
} from '@tauri-apps/api/webviewWindow'
import {
  currentMonitor,
  cursorPosition,
  getCurrentWindow,
  monitorFromPoint,
  primaryMonitor,
} from '@tauri-apps/api/window'

import { logger } from '@/lib/log'
import { strings } from '@/strings'

import {
  buildSessionOverlayWindowOptions,
  normalizeSessionOverlayPresentPayload,
  sessionOverlayMeasurementTarget,
  SESSION_OVERLAY_CREATE_TIMEOUT_MS,
  SESSION_OVERLAY_DISMISS,
  SESSION_OVERLAY_LAYOUT_TIMEOUT_MS,
  SESSION_OVERLAY_PRESENT,
  SESSION_OVERLAY_QUEUE_CAP,
  SESSION_OVERLAY_READY,
  SESSION_OVERLAY_READY_TIMEOUT_MS,
  SESSION_OVERLAY_UPDATE,
  SESSION_OVERLAY_WINDOW_LABEL,
  SESSION_OVERLAY_WINDOW_MARGIN,
  SESSION_OVERLAY_WINDOW_MAX_HEIGHT,
  SESSION_OVERLAY_WINDOW_WIDTH,
  SessionOverlayQueue,
  type SessionOverlayItem,
  type SessionOverlayItemInput,
  type SessionOverlayPresentPayload,
  type SessionOverlayUpdatePayload,
  type SessionOverlayWindowPosition,
} from './sessionOverlay'

// #317 — the overlay window is created from JS, so the platform tweaks Tauri's
// window options cannot express (macOS `fullScreenAuxiliary`, see
// `commands/session_overlay.rs`) are applied by this command between creation
// and the first reveal.
export const SESSION_OVERLAY_PREPARE_COMMAND = 'session_overlay_prepare'

// Diagnostics only: ids, revisions and heights. Never the notification text.
const log = logger.child('session.overlay')

type PendingPresentation = {
  revision: number
  itemKey: string
}

type VisiblePresentation = PendingPresentation & {
  height: number
}

const queue = new SessionOverlayQueue(SESSION_OVERLAY_QUEUE_CAP)
let expiryTimer: ReturnType<typeof setTimeout> | null = null
let layoutTimer: ReturnType<typeof setTimeout> | null = null
let readyTimer: ReturnType<typeof setTimeout> | null = null
let windowReady = false
let overlayPosition: SessionOverlayWindowPosition | null = null
let creatingWindow: Promise<WebviewWindow | null> | null = null
let serial: Promise<void> = Promise.resolve()
let nextRevision = 0
let pendingPresentation: PendingPresentation | null = null
let visiblePresentation: VisiblePresentation | null = null
let eventListenerPromise: Promise<void> | null = null
let eventUnlistens: Array<() => void> = []
let runtimeDisposed = false

export function pushSessionOverlayItem(
  input: SessionOverlayItemInput
): Promise<void> {
  return runSerial(async () => {
    if (runtimeDisposed || !(await mainWindowNeedsOverlay())) return
    try {
      // Register every overlay-to-main event before constructing the webview.
      // Otherwise a fast renderer can emit READY before React's bridge effect
      // has subscribed, leaving the first queued notification hidden forever.
      await ensureOverlayEventListeners()
    } catch {
      return
    }
    if (runtimeDisposed) return
    queue.enqueue(input, Date.now())
    await syncOverlayWindow()
  })
}

export function dismissSessionOverlayItem(id: string): Promise<void> {
  return runSerial(async () => {
    if (runtimeDisposed) return
    queue.dismiss(id, Date.now())
    await syncOverlayWindow()
  })
}

export function clearSessionOverlay(): Promise<void> {
  return runSerial(async () => {
    if (runtimeDisposed) return
    queue.clear()
    await syncOverlayWindow()
  })
}

export function markSessionOverlayReady(): Promise<void> {
  return runSerial(async () => {
    if (runtimeDisposed) return
    // READY identifies a fresh renderer lifecycle, not merely a native window.
    // Invalidate the prior render state so a reloaded webview always receives
    // the current snapshot instead of remaining visible-but-blank.
    resetPresentationState()
    clearReadyTimer()
    windowReady = true
    await syncOverlayWindow()
  })
}

// The renderer reports its intrinsic CSS height only after the new content has
// laid out. The main window remains the sole owner of native window geometry:
// it validates the revision and height, resizes, then reveals the overlay. A
// late measurement from superseded content is ignored rather than flashing a
// stale or incorrectly sized card.
export function presentSessionOverlayItem(payload: unknown): Promise<void> {
  const normalized = normalizeSessionOverlayPresentPayload(payload)
  if (!normalized || runtimeDisposed) return Promise.resolve()
  return runSerial(() => applySessionOverlayPresentation(normalized))
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
  } catch (err) {
    log.warn('window_state.failed', { err })
    return false
  }
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    runtimeDisposed = true
    if (expiryTimer !== null) {
      clearTimeout(expiryTimer)
      expiryTimer = null
    }
    clearLayoutTimer()
    clearReadyTimer()
    for (const unlisten of eventUnlistens) unlisten()
    eventUnlistens = []
  })
}

function runSerial(task: () => Promise<void>): Promise<void> {
  const next = serial.then(task, task)
  serial = next.catch(() => {})
  return next
}

async function applySessionOverlayPresentation(
  normalized: SessionOverlayPresentPayload
): Promise<void> {
  const pending = pendingPresentation
  const visible = visiblePresentation
  const target = sessionOverlayMeasurementTarget(
    normalized.revision,
    pending?.revision ?? null,
    visible?.revision ?? null
  )
  if (target === null) return

  if (target === 'pending' && pending) {
    const snapshot = queue.snapshot(Date.now())
    if (!snapshot.item || itemLayoutKey(snapshot.item) !== pending.itemKey) {
      await syncOverlayWindow()
      return
    }

    const overlayWindow = await getOverlayWindow()
    if (!overlayWindow) {
      resetPresentationState()
      windowReady = false
      return
    }

    try {
      await resizeOverlayWindow(overlayWindow, normalized.height)
      await overlayWindow.show()
      clearLayoutTimer()
      pendingPresentation = null
      visiblePresentation = {
        ...pending,
        height: normalized.height,
      }
      log.debug('present.shown', {
        revision: normalized.revision,
        height: normalized.height,
        queued: snapshot.queued,
      })
    } catch (err) {
      log.warn('present.failed', { revision: normalized.revision, err })
      await abandonOverlayWindow(overlayWindow)
    }
    return
  }

  // ResizeObserver can legitimately report a second height after bundled
  // fonts finish loading. Accept it only for the currently visible revision;
  // once a newer presentation is pending, old measurements are stale.
  if (!visible || normalized.height === visible.height) return

  const overlayWindow = await getOverlayWindow()
  if (!overlayWindow) {
    resetPresentationState()
    windowReady = false
    return
  }
  try {
    await resizeOverlayWindow(overlayWindow, normalized.height)
    visiblePresentation = { ...visible, height: normalized.height }
  } catch (err) {
    log.warn('present.failed', { revision: normalized.revision, err })
    await abandonOverlayWindow(overlayWindow)
  }
}

// tao's macOS resize is `setContentSize:`, which keeps the window's bottom-left
// corner fixed — so growing to fit the measured content slid the card's top
// edge up under the menu bar. Re-assert the top-left corner after every
// resize; on Windows and X11 that is the position the window already has, and
// Wayland refuses client positioning, so the call is best effort.
async function resizeOverlayWindow(
  overlayWindow: WebviewWindow,
  height: number
): Promise<void> {
  await overlayWindow.setSize(
    new LogicalSize(SESSION_OVERLAY_WINDOW_WIDTH, height)
  )
  if (!overlayPosition) return
  await overlayWindow
    .setPosition(new LogicalPosition(overlayPosition.x, overlayPosition.y))
    .catch(() => {})
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

  const itemKey = itemLayoutKey(snapshot.item)
  if (
    pendingPresentation?.itemKey === itemKey ||
    (!pendingPresentation && visiblePresentation?.itemKey === itemKey)
  ) {
    return
  }

  const revision = ++nextRevision
  pendingPresentation = { revision, itemKey }
  clearLayoutTimer()

  const payload: SessionOverlayUpdatePayload = { revision, snapshot }
  try {
    // New content stays hidden until its measured size is applied. `hide()` is
    // best-effort because a newly created window starts hidden already.
    await overlayWindow.hide().catch(() => {})
    await emitTo(SESSION_OVERLAY_WINDOW_LABEL, SESSION_OVERLAY_UPDATE, payload)
    scheduleLayoutFallback(revision)
  } catch (err) {
    log.warn('update.emit_failed', { revision, err })
    await abandonOverlayWindow(overlayWindow)
  }
}

function scheduleExpiry(expiresAt: number | null, now: number): void {
  if (expiryTimer !== null) {
    clearTimeout(expiryTimer)
    expiryTimer = null
  }
  if (expiresAt === null) return
  expiryTimer = setTimeout(
    () => {
      expiryTimer = null
      void runSerial(syncOverlayWindow)
    },
    Math.max(0, expiresAt - now)
  )
}

function scheduleLayoutFallback(revision: number): void {
  clearLayoutTimer()
  layoutTimer = setTimeout(() => {
    layoutTimer = null
    void runSerial(async () => {
      // Check within the serialized queue. A real measurement already queued
      // ahead of this timeout clears `pendingPresentation`, so the fallback can
      // never resize a correctly presented card back to the maximum height.
      if (pendingPresentation?.revision !== revision) return
      await applySessionOverlayPresentation({
        revision,
        height: SESSION_OVERLAY_WINDOW_MAX_HEIGHT,
      })
    })
  }, SESSION_OVERLAY_LAYOUT_TIMEOUT_MS)
}

function clearLayoutTimer(): void {
  if (layoutTimer === null) return
  clearTimeout(layoutTimer)
  layoutTimer = null
}

// A renderer that never announces READY leaves the queue draining by TTL with
// nothing on screen. The lifecycle already recovers (the emptied queue closes
// the window and the next item creates a fresh one); this only makes the
// silence visible in a diagnostics archive.
function scheduleReadyWatchdog(): void {
  clearReadyTimer()
  readyTimer = setTimeout(() => {
    readyTimer = null
    if (!windowReady) log.warn('ready.timeout')
  }, SESSION_OVERLAY_READY_TIMEOUT_MS)
}

function clearReadyTimer(): void {
  if (readyTimer === null) return
  clearTimeout(readyTimer)
  readyTimer = null
}

async function ensureOverlayEventListeners(): Promise<void> {
  if (runtimeDisposed || eventUnlistens.length > 0) return
  if (!eventListenerPromise) {
    eventListenerPromise = registerOverlayEventListeners().finally(() => {
      eventListenerPromise = null
    })
  }
  await eventListenerPromise
}

async function registerOverlayEventListeners(): Promise<void> {
  const mainWebview = getCurrentWebviewWindow()
  const unlistens: Array<() => void> = []
  try {
    unlistens.push(
      await mainWebview.listen<unknown>(SESSION_OVERLAY_READY, () => {
        void markSessionOverlayReady()
      })
    )
    unlistens.push(
      await mainWebview.listen<unknown>(SESSION_OVERLAY_DISMISS, (event) => {
        const id = sessionOverlayDismissId(event.payload)
        if (id !== null) void dismissSessionOverlayItem(id)
      })
    )
    unlistens.push(
      await mainWebview.listen<unknown>(SESSION_OVERLAY_PRESENT, (event) => {
        void presentSessionOverlayItem(event.payload)
      })
    )
  } catch (error) {
    for (const unlisten of unlistens) unlisten()
    throw error
  }

  if (runtimeDisposed) {
    for (const unlisten of unlistens) unlisten()
    return
  }
  eventUnlistens = unlistens
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
  resetPresentationState()
  creatingWindow = createOverlayWindow().finally(() => {
    creatingWindow = null
  })
  return creatingWindow
}

async function createOverlayWindow(): Promise<WebviewWindow | null> {
  const position = await resolveOverlayPosition()
  overlayPosition = position
  const overlayWindow = new WebviewWindow(
    SESSION_OVERLAY_WINDOW_LABEL,
    buildSessionOverlayWindowOptions(position, strings.app.name)
  )

  const created = await new Promise<boolean>((resolve) => {
    let settled = false
    let timeout: ReturnType<typeof setTimeout> | null = null
    const finish = (result: boolean) => {
      if (settled) return
      settled = true
      if (timeout !== null) clearTimeout(timeout)
      resolve(result)
    }
    timeout = setTimeout(() => {
      log.warn('create.timeout')
      finish(false)
    }, SESSION_OVERLAY_CREATE_TIMEOUT_MS)
    void overlayWindow
      .once('tauri://created', () => finish(true))
      .catch(() => finish(false))
    void overlayWindow
      .once<unknown>('tauri://error', (event) => {
        log.warn('create.failed', { err: event.payload })
        finish(false)
      })
      .catch(() => finish(false))
  })
  if (!created) return null

  // Runs inside the serialized creation step, so READY and PRESENT — which
  // queue behind it — can never reveal a window that skipped this.
  try {
    await invoke(SESSION_OVERLAY_PREPARE_COMMAND)
  } catch (err) {
    log.warn('prepare.failed', { err })
  }
  scheduleReadyWatchdog()
  return overlayWindow
}

async function resolveOverlayPosition(): Promise<{
  x: number
  y: number
} | null> {
  try {
    const cursor = await cursorPosition()
    const monitor =
      (await monitorFromPoint(cursor.x, cursor.y)) ??
      (await currentMonitor()) ??
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

async function getOverlayWindow(): Promise<WebviewWindow | null> {
  try {
    return await WebviewWindow.getByLabel(SESSION_OVERLAY_WINDOW_LABEL)
  } catch {
    return null
  }
}

async function abandonOverlayWindow(
  overlayWindow: WebviewWindow
): Promise<void> {
  windowReady = false
  resetPresentationState()
  clearReadyTimer()
  await overlayWindow.close().catch(() => {})
}

async function closeOverlayWindow(): Promise<void> {
  if (expiryTimer !== null) {
    clearTimeout(expiryTimer)
    expiryTimer = null
  }
  windowReady = false
  resetPresentationState()
  clearReadyTimer()
  try {
    const overlayWindow =
      (await WebviewWindow.getByLabel(SESSION_OVERLAY_WINDOW_LABEL)) ??
      (await creatingWindow)
    await overlayWindow?.close()
  } catch {
    // The overlay may already have closed itself after receiving an empty queue.
  }
}

function resetPresentationState(): void {
  clearLayoutTimer()
  pendingPresentation = null
  visiblePresentation = null
}

function sessionOverlayDismissId(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null
  const id = (payload as Record<string, unknown>).id
  return typeof id === 'string' && id.length > 0 ? id : null
}

function itemLayoutKey(item: SessionOverlayItem): string {
  return JSON.stringify([item.id, item.title, item.body, item.tone])
}
