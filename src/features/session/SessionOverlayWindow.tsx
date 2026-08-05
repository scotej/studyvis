import { useCallback, useEffect, useState } from 'react'
import {
  AlertTriangleIcon,
  CircleAlertIcon,
  MessageSquareIcon,
  XIcon,
} from 'lucide-react'

import { strings } from '@/strings'

import {
  SESSION_OVERLAY_DISMISS,
  SESSION_OVERLAY_READY,
  SESSION_OVERLAY_UPDATE,
  type SessionOverlaySnapshot,
  type SessionOverlayTone,
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

export function SessionOverlayWindow({
  initialSnapshot = null,
  runtime,
}: SessionOverlayWindowProps) {
  const [snapshot, setSnapshot] = useState<SessionOverlaySnapshot | null>(
    initialSnapshot
  )
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
      .listen<SessionOverlaySnapshot>(SESSION_OVERLAY_UPDATE, (payload) => {
        if (!cancelled) setSnapshot(payload)
      })
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
    <div className="flex h-full w-full items-start justify-end bg-transparent p-4">
      <section
        data-testid="session-overlay-window"
        role={item.tone === 'neutral' ? 'status' : 'alert'}
        aria-atomic="true"
        className={`group relative flex min-h-24 w-full gap-3 rounded-xl border bg-bg-raised p-4 pr-12 shadow-lg ${toneBorder(item.tone)}`}
      >
        <span className={`mt-0.5 shrink-0 ${toneText(item.tone)}`} aria-hidden>
          {toneIcon(item.tone)}
        </span>
        <span className="min-w-0">
          <strong className="block text-sm font-semibold text-text-primary">
            {item.title}
          </strong>
          <span className="mt-1 line-clamp-3 whitespace-pre-wrap break-words text-sm leading-snug text-text-secondary">
            {item.body}
          </span>
        </span>
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
