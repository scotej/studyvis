import { LogicalSize } from '@tauri-apps/api/dpi'
import { emitTo, listen } from '@tauri-apps/api/event'
import { WebviewWindow } from '@tauri-apps/api/webviewWindow'
import {
  currentMonitor,
  cursorPosition,
  getCurrentWindow,
  monitorFromPoint,
  primaryMonitor,
} from '@tauri-apps/api/window'

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
  SESSION_OVERLAY_UPDATE,
  SESSION_OVERLAY_WINDOW_LABEL,
  SESSION_OVERLAY_WINDOW_MARGIN,
  SESSION_OVERLAY_WINDOW_MAX_HEIGHT,
  SESSION_OVERLAY_WINDOW_WIDTH,
  SessionOverlayQueue,
  type SessionOverlayItem,
  type SessionOverlayItemInput,
  type SessionOverlayUpdatePayload,
} from './sessionOverlay'

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
let windowReady = false
let creatingWindow: Promise<WebviewWindow | null> | null = null
let serial: Promise<void> = Promise.resolve()
let nextRevision = 0
let pendingPresentation: PendingPresentation | null = null
let visiblePresentation: VisiblePresentation | null = null
let presentationListenerPromise: Promise<void> | null = null
let presentationUnlisten: (() => void) | null = null
let runtimeDisposed = false

export function pushSessionOverlayItem(
  input: SessionOverlayItemInput
): Promise<void> {
  return runSerial(async () => {
    if (!(await mainWindowNeedsOverlay())) return
    await ensurePresentationListener().catch(() => {})
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
    await ensurePresentationListener().catch(() => {})
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
  if (!normalized) return Promise.resolve()

  return runSerial(async () => {
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
        await overlayWindow.setSize(
          new LogicalSize(SESSION_OVERLAY_WINDOW_WIDTH, normalized.height)
        )
        await overlayWindow.show()
        clearLayoutTimer()
        pendingPresentation = null
        visiblePresentation = {
          ...pending,
          height: normalized.height,
        }
      } catch {
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
      await overlayWindow.setSize(
        new LogicalSize(SESSION_OVERLAY_WINDOW_WIDTH, normalized.height)
      )
      visiblePresentation = { ...visible, height: normalized.height }
    } catch {
      await abandonOverlayWindow(overlayWindow)
    }
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

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    runtimeDisposed = true
    presentationUnlisten?.()
    presentationUnlisten = null
  })
}

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
  } catch {
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
    // A renderer regression must not make session events disappear entirely.
    // The maximum safe height exposes the full bounded body region and a later
    // real measurement for this revision can still shrink it.
    void presentSessionOverlayItem({
      revision,
      height: SESSION_OVERLAY_WINDOW_MAX_HEIGHT,
    })
  }, SESSION_OVERLAY_LAYOUT_TIMEOUT_MS)
}

function clearLayoutTimer(): void {
  if (layoutTimer === null) return
  clearTimeout(layoutTimer)
  layoutTimer = null
}

async function ensurePresentationListener(): Promise<void> {
  if (runtimeDisposed || presentationUnlisten) return
  if (!presentationListenerPromise) {
    presentationListenerPromise = listen<unknown>(
      SESSION_OVERLAY_PRESENT,
      (event) => {
        void presentSessionOverlayItem(event.payload)
      }
    )
      .then((unlisten) => {
        if (runtimeDisposed) unlisten()
        else presentationUnlisten = unlisten
      })
      .finally(() => {
        presentationListenerPromise = null
      })
  }
  await presentationListenerPromise
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
  const overlayWindow = new WebviewWindow(
    SESSION_OVERLAY_WINDOW_LABEL,
    buildSessionOverlayWindowOptions(position, strings.app.name)
  )

  return new Promise((resolve) => {
    let settled = false
    let timeout: ReturnType<typeof setTimeout> | null = null
    const finish = (result: WebviewWindow | null) => {
      if (settled) return
      settled = true
      if (timeout !== null) clearTimeout(timeout)
      resolve(result)
    }
    timeout = setTimeout(() => finish(null), SESSION_OVERLAY_CREATE_TIMEOUT_MS)
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
  await overlayWindow.close().catch(() => {})
}

async function closeOverlayWindow(): Promise<void> {
  if (expiryTimer !== null) {
    clearTimeout(expiryTimer)
    expiryTimer = null
  }
  windowReady = false
  resetPresentationState()
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

function itemLayoutKey(item: SessionOverlayItem): string {
  return JSON.stringify([item.id, item.title, item.body, item.tone])
}
