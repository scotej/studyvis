import { useEffect, useState } from 'react'
import { Coffee } from 'lucide-react'

import { tokens } from '@/design/tokens'
import { cn } from '@/lib/utils'
import { strings } from '@/strings'

export type BreakCountdownBadgeProps = {
  // Wall-clock ms epoch the break is scheduled to end. Null suppresses
  // the badge so an upstream "no break active" state has no edge-case
  // branch.
  endsAt: number | null
  className?: string
  // Test seam — production uses Date.now via a 1 s interval.
  now?: () => number
}

// V2-P7 — Persistent countdown badge while an approved break is active.
// Mirrors the fixed-position placement of SelfWarningBadge (bottom-right,
// above the audit panel) but uses the warning palette + a coffee icon
// so the affordance reads as "you're on a break" at a glance. The break
// rule layer in features/session/break.ts owns the actual end timer;
// this component is purely presentational and ticks once per second so
// the displayed mm:ss stays current.
export function BreakCountdownBadge({
  endsAt,
  className,
  now = () => Date.now(),
}: BreakCountdownBadgeProps) {
  const [tick, setTick] = useState(0)

  useEffect(() => {
    if (endsAt == null) return
    const handle = setInterval(() => setTick((t) => t + 1), 1000)
    return () => clearInterval(handle)
  }, [endsAt])

  if (endsAt == null) return null
  const remainingMs = Math.max(0, endsAt - now())
  const totalSeconds = Math.ceil(remainingMs / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  const label = `${minutes}:${String(seconds).padStart(2, '0')}`

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={strings.session.badges.breakAriaLabel}
      data-testid="break-countdown-badge"
      data-tick={tick}
      style={{ zIndex: tokens.zIndex.toast }}
      className={cn(
        'pointer-events-none fixed bottom-6 right-6 max-w-sm',
        'flex items-center gap-3 rounded-md border border-status-warning/40 bg-bg-raised px-4 py-3 text-sm shadow-md',
        className
      )}
    >
      <Coffee
        aria-hidden="true"
        className="size-4 shrink-0 text-status-warning"
      />
      <div className="flex flex-col">
        <span className="font-medium text-text-primary">
          {strings.session.badges.breakTitle}
        </span>
        <span className="font-mono tabular-nums text-text-secondary">
          {strings.session.badges.breakRemaining(label)}
        </span>
      </div>
    </div>
  )
}
