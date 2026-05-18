import { AlertCircle } from 'lucide-react'

import { tokens } from '@/design/tokens'
import { cn } from '@/lib/utils'

export type SelfWarningBadgeProps = {
  // Reasoning text from the score machine's warning event. Empty string
  // suppresses the badge so an upstream "no warning active" state has no
  // edge-case branch.
  reasoning: string
  className?: string
}

// V2-P6 — the silent, off-task-user-only warning surface. Renders in the
// bottom-right above the audit panel; `aria-live=polite` so screen readers
// announce it without snatching focus mid-task. Auto-dismissal is owned
// by `useAlertsUiStore` (30 s TTL, or the next on_task sample) — this
// component is purely presentational.
export function SelfWarningBadge({
  reasoning,
  className,
}: SelfWarningBadgeProps) {
  if (!reasoning) return null

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label="Self-warning"
      data-testid="self-warning-badge"
      style={{ zIndex: tokens.zIndex.toast }}
      className={cn(
        'pointer-events-none fixed bottom-6 right-6 max-w-sm',
        'flex items-start gap-3 rounded-md border border-status-warning/40 bg-bg-raised px-4 py-3 text-sm shadow-md',
        className
      )}
    >
      <AlertCircle
        aria-hidden="true"
        className="mt-0.5 size-4 shrink-0 text-status-warning"
      />
      <div className="flex flex-col gap-1">
        <span className="font-medium text-text-primary">
          Heads up, looking off-task.
        </span>
        <span className="text-text-secondary">{reasoning}</span>
      </div>
    </div>
  )
}
