import { tokens } from '@/design/tokens'
import { strings } from '@/strings'

export const SESSION_OVERLAY_WINDOW_LABEL = 'session-overlay'
export const SESSION_OVERLAY_UPDATE = 'session-overlay:update'
export const SESSION_OVERLAY_READY = 'session-overlay:ready'
export const SESSION_OVERLAY_DISMISS = 'session-overlay:dismiss'

export const SESSION_OVERLAY_TTL_MS = 15_000
export const SESSION_OVERLAY_QUEUE_CAP = 8
export const SESSION_OVERLAY_WINDOW_WIDTH = 420
export const SESSION_OVERLAY_WINDOW_HEIGHT = 144
export const SESSION_OVERLAY_WINDOW_MARGIN = tokens.space[4]
export const SESSION_OVERLAY_CREATE_TIMEOUT_MS = 5_000

export type SessionOverlayTone = 'neutral' | 'warning' | 'alerted'

export type SessionOverlayItem = {
  id: string
  title: string
  body: string
  tone: SessionOverlayTone
  createdAt: number
  expiresAt: number
}

export type SessionOverlayItemInput = Pick<
  SessionOverlayItem,
  'id' | 'title' | 'body' | 'tone'
> & {
  ttlMs?: number
}

export type SessionOverlaySnapshot = {
  item: SessionOverlayItem | null
  queued: number
}

export type SessionOverlayDismissPayload = { id: string }

export type OverlayToastLike = {
  id: string | number
  title?: unknown
  description?: unknown
  type?: string
}

export class SessionOverlayQueue {
  private readonly capacity: number
  private items: SessionOverlayItem[] = []

  constructor(capacity = SESSION_OVERLAY_QUEUE_CAP) {
    this.capacity = Math.max(1, Math.floor(capacity))
  }

  enqueue(input: SessionOverlayItemInput, now: number): SessionOverlaySnapshot {
    this.prune(now)
    const ttlMs = Math.max(1, input.ttlMs ?? SESSION_OVERLAY_TTL_MS)
    const item: SessionOverlayItem = {
      id: input.id,
      title: input.title,
      body: input.body,
      tone: input.tone,
      createdAt: now,
      expiresAt: now + ttlMs,
    }
    const existing = this.items.findIndex((entry) => entry.id === item.id)
    if (existing >= 0) {
      this.items[existing] = item
    } else {
      this.items.push(item)
    }
    while (this.items.length > this.capacity) {
      this.items.splice(this.items.length > 1 ? 1 : 0, 1)
    }
    return this.snapshot(now)
  }

  dismiss(id: string, now: number): SessionOverlaySnapshot {
    this.prune(now)
    this.items = this.items.filter((item) => item.id !== id)
    return this.snapshot(now)
  }

  clear(): SessionOverlaySnapshot {
    this.items = []
    return { item: null, queued: 0 }
  }

  snapshot(now: number): SessionOverlaySnapshot {
    this.prune(now)
    return {
      item: this.items[0] ?? null,
      queued: Math.max(0, this.items.length - 1),
    }
  }

  private prune(now: number): void {
    this.items = this.items.filter((item) => item.expiresAt > now)
  }
}

export function overlayItemFromToast(
  toast: OverlayToastLike
): SessionOverlayItemInput | null {
  if (toast.type === 'loading') return null
  const title = textPart(toast.title)
  const description = textPart(toast.description)
  const body = [title, description].filter(Boolean).join('\n')
  if (!body) return null
  return {
    id: `toast:${String(toast.id)}`,
    title: strings.app.name,
    body,
    tone:
      toast.type === 'error'
        ? 'alerted'
        : toast.type === 'warning'
          ? 'warning'
          : 'neutral',
    ttlMs: SESSION_OVERLAY_TTL_MS,
  }
}

export function overlayToastSignature(toast: OverlayToastLike): string {
  return JSON.stringify([
    textPart(toast.title),
    textPart(toast.description),
    toast.type ?? 'default',
  ])
}

function textPart(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}
