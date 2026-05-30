import { EyeOff, PauseCircle, ScanFace } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

import { cn } from '@/lib/utils'
import { strings } from '@/strings'

export type AiStatus = 'off' | 'active' | 'paused' | 'error'

// Icon tint carries the status color; the label always renders in a
// neutral text token so small footer text keeps AA contrast on
// bg-surface. Color only reinforces the per-status icon + label, so the
// chip satisfies no-color-alone (WCAG 1.4.1) on its own.
const STATUS_ICON: Record<AiStatus, LucideIcon> = {
  off: EyeOff,
  active: ScanFace,
  paused: PauseCircle,
  error: EyeOff,
}

const STATUS_ICON_TINT: Record<AiStatus, string> = {
  off: 'text-text-secondary',
  active: 'text-status-focused',
  paused: 'text-status-warning',
  error: 'text-status-alerted',
}

const STATUS_LABEL: Record<AiStatus, string> = {
  off: strings.session.aiStatus.off,
  active: strings.session.aiStatus.active,
  paused: strings.session.aiStatus.paused,
  error: strings.session.aiStatus.error,
}

export type AiStatusChipProps = {
  status: AiStatus
  className?: string
}

// Persistent, presentational read-out of whether the camera is being
// analyzed (PLAN.md privacy register). The sample-loop callbacks in
// SessionView drive the status; transient toasts still announce each
// transition, so the chip stays static (role="img" + aria-label) to
// avoid double-announcing alongside those live toasts.
export function AiStatusChip({ status, className }: AiStatusChipProps) {
  const Icon = STATUS_ICON[status]
  const label = STATUS_LABEL[status]
  return (
    <span
      role="img"
      aria-label={label}
      data-testid="ai-status-chip"
      className={cn(
        'inline-flex items-center gap-1.5 text-text-secondary',
        className
      )}
    >
      <Icon
        aria-hidden="true"
        strokeWidth={1.5}
        className={cn('size-4 shrink-0', STATUS_ICON_TINT[status])}
      />
      <span>{label}</span>
    </span>
  )
}
