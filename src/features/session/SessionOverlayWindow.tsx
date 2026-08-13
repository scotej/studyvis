import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AlertTriangleIcon,
  CircleAlertIcon,
  MessageSquareIcon,
  XIcon,
} from 'lucide-react'

import { strings } from '@/strings'

import {
  normalizeSessionOverlayWindowHeight,
  SESSION_OVERLAY_BODY_MAX_HEIGHT,
  SESSION_OVERLAY_DISMISS,
  SESSION_OVERLAY_LAYOUT_TIMEOUT_MS,
  SESSION_OVERLAY_PRESENT,
  SESSION_OVERLAY_READY,
  SESSION_OVERLAY_UPDATE,
  type SessionOverlaySnapshot,
  type SessionOverlayTone,
  type SessionOverlayUpdatePayload,
} from './sessionOverlay'

export type SessionOverlayRuntime = {
  listen: <T>(
    event: string,
    handler: (payload: T) => void
  ) => Promise<() => void>
  emit: (event: string, payload?: unknown) => Promise<void>
  close: () => Promise<void>
}

export type SessionOverlayWindowProps = {
  initialSnapshot?: SessionOverlaySnapshot | null
  runtime?: SessionOverlayRuntime
}

type SessionOverlayRenderState = {
  revision: number
  snapshot: SessionOverlaySnapshot
}

export function SessionOverlayWindow({
  initialSnapshot = null,
  runtime,
}: SessionOverlayWindowProps) {
  const [renderState, setRenderState] =
    useState<SessionOverlayRenderState | null>(() =>
      initialSnapshot
        ? {
            revision: 0,
            snapshot: initialSnapshot,
          }
        : null
    )
  const frameRef = useRef<HTMLDivElement>(null)
  const snapshot = renderState?.snapshot ?? null
  const item = snapshot?.item ?? null

  const dismiss = useCallback(() => {
    if (!runtime || !item) return
    void runtime
      .emit(SESSION_OVERLAY_DISMISS, { id: item.id })
      .catch(() => runtime.close())
  }, [item, runtime])

  useEffect(() => {
    if (!runtime) return
    let cancelled = false
    let unlisten: (() => void) | null = null
    void runtime
      .listen<SessionOverlayUpdatePayload>(
        SESSION_OVERLAY_UPDATE,
        (payload) => {
          if (!cancelled) setRenderState(payload)
        }
      )
      .then((off) => {
        if (cancelled) off()
        else unlisten = off
      })
      .then(() => {
        if (!cancelled) return runtime.emit(SESSION_OVERLAY_READY, {})
      })
      .catch(() => runtime.close())
    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [runtime])

  useEffect(() => {
    if (!runtime || snapshot === null || snapshot.item !== null) return
    void runtime.close()
  }, [runtime, snapshot])

  // Measure the actual rendered card rather than estimating from character
  // counts. This follows font metrics, wrapping, explicit newlines, theme, and
  // display scaling on both WebView2 and WKWebView. ResizeObserver catches the
  // second layout pass when bundled fonts finish loading.
  useEffect(() => {
    if (!runtime || !item || !renderState || renderState.revision <= 0) return
    const frame = frameRef.current
    if (!frame) return

    let cancelled = false
    let lastHeight: number | null = null

    const measure = (force = false) => {
      if (cancelled) return
      const measured = Math.max(
        frame.scrollHeight,
        frame.getBoundingClientRect().height
      )
      const height = normalizeSessionOverlayWindowHeight(measured)
      if (height === null || (!force && height === lastHeight)) return
      lastHeight = height
      void runtime
        .emit(SESSION_OVERLAY_PRESENT, {
          revision: renderState.revision,
          height,
        })
        .catch(() => runtime.close())
    }

    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(frame)
    // Do not defer the first measurement to requestAnimationFrame: native
    // hidden windows can pause animation frames, and this window intentionally
    // stays hidden until a valid measurement has been applied.
    measure()
    if ('fonts' in document) {
      void document.fonts.ready.then(() => measure()).catch(() => {})
    }
    // Force one post-fallback report. It is harmless when the runtime already
    // has the same height and repairs the narrow timeout-edge race where a
    // fallback was queued behind the real measurement.
    const settleTimer = setTimeout(
      () => measure(true),
      SESSION_OVERLAY_LAYOUT_TIMEOUT_MS + 250
    )

    return () => {
      cancelled = true
      clearTimeout(settleTimer)
      observer?.disconnect()
    }
  }, [item, renderState, runtime])

  useEffect(() => {
    if (!item) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      dismiss()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [dismiss, item])

  if (!item) {
    return <div className="h-full w-full bg-transparent" aria-hidden="true" />
  }

  return (
    <div
      ref={frameRef}
      className="flex w-full items-start justify-end bg-transparent p-4"
    >
      <section
        data-testid="session-overlay-window"
        role={item.tone === 'neutral' ? 'status' : 'alert'}
        aria-atomic="true"
        className={`group relative flex min-h-24 w-full gap-3 rounded-xl border bg-bg-raised p-4 pr-12 shadow-md ${toneBorder(item.tone)}`}
      >
        <span className={`mt-0.5 shrink-0 ${toneText(item.tone)}`} aria-hidden>
          {toneIcon(item.tone)}
        </span>
        <div className="min-w-0 flex-1">
          <strong className="block text-sm font-semibold text-text-primary">
            {item.title}
          </strong>
          <div
            data-testid="session-overlay-body"
            tabIndex={0}
            className="mt-1 overflow-y-auto whitespace-pre-wrap break-words rounded-sm text-sm leading-snug text-text-secondary outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
            style={{ maxHeight: SESSION_OVERLAY_BODY_MAX_HEIGHT }}
          >
            {item.body}
          </div>
        </div>
        <button
          type="button"
          onClick={dismiss}
          aria-label={strings.common.actions.close}
          className="pointer-events-none absolute right-2 top-2 inline-flex size-8 items-center justify-center rounded-md text-text-secondary opacity-0 outline-none transition-opacity hover:bg-bg-sunk hover:text-text-primary focus-visible:pointer-events-auto focus-visible:opacity-100 focus-visible:ring-3 focus-visible:ring-accent-ring group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100"
        >
          <XIcon className="size-4" aria-hidden />
        </button>
      </section>
    </div>
  )
}

function toneBorder(tone: SessionOverlayTone): string {
  if (tone === 'alerted') return 'border-status-alerted/60'
  if (tone === 'warning') return 'border-status-warning/60'
  return 'border-border-default'
}

function toneText(tone: SessionOverlayTone): string {
  if (tone === 'alerted') return 'text-status-alerted'
  if (tone === 'warning') return 'text-status-warning'
  return 'text-accent-default'
}

function toneIcon(tone: SessionOverlayTone) {
  if (tone === 'alerted') return <CircleAlertIcon className="size-5" />
  if (tone === 'warning') return <AlertTriangleIcon className="size-5" />
  return <MessageSquareIcon className="size-5" />
}
