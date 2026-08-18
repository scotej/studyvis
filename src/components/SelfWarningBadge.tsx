import { AlertCircle, XIcon } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { tokens } from '@/design/tokens'
import { cn } from '@/lib/utils'
import { strings } from '@/strings'

export type SelfWarningBadgeProps = {
  // Reasoning text from the score machine's warning event. Empty string
  // suppresses the badge so an upstream "no warning active" state has no
  // edge-case branch.
  reasoning: string
  // Clears the warning now instead of waiting out the store's 30 s TTL.
  // Required, not optional: a caller that forgets it re-arms issue #235.
  onDismiss: () => void
  className?: string
}

// V2-P6 — the silent, off-task-user-only warning surface. Renders in the
// bottom-right above the audit panel; `aria-live=polite` so screen readers
// announce it without snatching focus mid-task. Auto-dismissal is owned
// by `useAlertsUiStore` (30 s TTL, or the next on_task sample).
//
// Issue #235 — the card was `pointer-events-none` so it could never be waved
// off early, and a hover-revealed dismiss needs the pointer over the card. It
// now takes pointer events: a max-w-sm corner of the session is unclickable
// for at most the 30 s TTL, and the X is what buys back the rest of it. The
// reveal classes match SessionOverlayWindow's dismiss so the two warning
// surfaces behave identically, including keeping the invisible button out of
// the hit-testing path until it is actually shown.
export function SelfWarningBadge({
  reasoning,
  onDismiss,
  className,
}: SelfWarningBadgeProps) {
  if (!reasoning) return null

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={strings.session.badges.selfWarningAriaLabel}
      data-testid="self-warning-badge"
      style={{ zIndex: tokens.zIndex.toast }}
      className={cn(
        'group fixed bottom-6 right-6 max-w-sm',
        'flex items-start gap-3 rounded-md border border-status-warning/40 bg-bg-raised py-3 pl-4 pr-12 text-sm shadow-md',
        className
      )}
    >
      <AlertCircle
        aria-hidden="true"
        className="mt-0.5 size-4 shrink-0 text-status-warning"
      />
      <div className="flex flex-col gap-1">
        <span className="font-medium text-text-primary">
          {strings.session.badges.selfWarningTitle}
        </span>
        <span className="text-text-secondary">{reasoning}</span>
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        onClick={onDismiss}
        aria-label={strings.session.badges.selfWarningDismissAriaLabel}
        className="pointer-events-none absolute right-2 top-2 text-text-secondary opacity-0 transition-opacity focus-visible:pointer-events-auto focus-visible:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100"
      >
        <XIcon aria-hidden="true" />
      </Button>
    </div>
  )
}
