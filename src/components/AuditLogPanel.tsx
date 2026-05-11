import { useEffect, useRef, useState } from 'react'

import { AuditLogRow } from '@/components/AuditLogRow'
import { tokens } from '@/design/tokens'
import { cn } from '@/lib/utils'

export type AuditLogEntry = {
  seq: number
  name: string
  // Pre-resolved action label, e.g. "joined" / "took a break".
  description: string
  ts: number
  // Optional context surfaced on hover (V2-P6 routes the AI reasoning here
  // for `ai_warning` / `ai_alert` rows).
  hoverDetail?: string
}

export type AuditLogPanelProps = {
  events: ReadonlyArray<AuditLogEntry>
  // Override "now" for deterministic timestamp rendering in stories/tests.
  // When omitted, the panel ticks its own clock once a minute.
  now?: number
  className?: string
}

const TICK_INTERVAL_MS = 60_000

// Right-rail audit log per DESIGN-SYSTEM.md §4 inventory + §8.3 wireframe.
// Fixed 320 wide (`tokens.sizes.auditPanelWidth`); auto-scrolls to the
// newest row only when the user is already at the bottom — preserving
// scroll position on read-back. `aria-live="polite"` so screen readers
// announce new rows without interrupting the user (V3 will refine).
export function AuditLogPanel({ events, now, className }: AuditLogPanelProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  // Track whether the user is pinned to the bottom. We don't use
  // `behavior: 'smooth'` because chained smooth-scrolls fight rapid arrivals.
  const [pinnedToBottom, setPinnedToBottom] = useState(true)
  // Tick `nowState` every minute so relative timestamps re-format. Lazy init
  // keeps Date.now() out of the render body (react-hooks/purity rule).
  const [nowState, setNowState] = useState(() => Date.now())

  useEffect(() => {
    if (now !== undefined) return
    const handle = setInterval(() => setNowState(Date.now()), TICK_INTERVAL_MS)
    return () => clearInterval(handle)
  }, [now])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    if (pinnedToBottom) el.scrollTop = el.scrollHeight
  }, [events.length, pinnedToBottom])

  const onScroll: React.UIEventHandler<HTMLDivElement> = (e) => {
    const el = e.currentTarget
    // 16px slack tolerates fractional scrolls + the briefly-misaligned
    // moment after a mutation observer fires before the layout settles.
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 16
    setPinnedToBottom(atBottom)
  }

  const effectiveNow = now ?? nowState

  return (
    <aside
      aria-label="Session log"
      className={cn(
        'flex h-full flex-col border-l border-border-subtle bg-bg-surface',
        className
      )}
      style={{ width: tokens.sizes.auditPanelWidth }}
      data-testid="audit-log-panel"
    >
      <header className="border-b border-border-subtle px-4 py-3 text-sm font-medium text-text-primary">
        Session log
      </header>
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="flex-1 overflow-y-auto"
      >
        {events.length === 0 ? (
          <p className="px-4 py-3 text-sm text-text-secondary">
            Events will appear here as people join, leave, and take breaks.
          </p>
        ) : (
          <ul
            aria-live="polite"
            aria-relevant="additions"
            className="m-0 list-none p-0"
          >
            {events.map((e) => (
              <AuditLogRow
                key={e.seq}
                name={e.name}
                description={e.description}
                ts={e.ts}
                now={effectiveNow}
                hoverDetail={e.hoverDetail}
              />
            ))}
          </ul>
        )}
      </div>
    </aside>
  )
}
