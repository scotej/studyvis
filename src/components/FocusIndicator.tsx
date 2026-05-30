import {
  AlertCircle,
  Circle,
  CircleDot,
  CircleOff,
  Coffee,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react'

import { cn } from '@/lib/utils'
import { strings } from '@/strings'

export type V1FocusState = 'online' | 'on_break' | 'offline'
export type V2FocusState = 'focused' | 'warning' | 'alerted' | 'offline'
export type FocusState = V1FocusState | V2FocusState

// Each state gets a grayscale-distinct glyph so the status reads without
// relying on color (WCAG 1.4.1). `online` (hollow ring) and `focused`
// (filled center) share a token color but differ by shape; `warning`
// (circle), `alerted` (triangle), and `on_break` (cup) are tellable apart by
// silhouette alone. Icon precedents: SelfWarningBadge=AlertCircle,
// BreakCountdownBadge=Coffee.
const STATE_ICONS: Record<FocusState, LucideIcon> = {
  online: Circle,
  on_break: Coffee,
  focused: CircleDot,
  warning: AlertCircle,
  alerted: TriangleAlert,
  offline: CircleOff,
}

const STATE_COLORS: Record<FocusState, string> = {
  online: 'text-status-online',
  on_break: 'text-status-warning',
  focused: 'text-status-focused',
  warning: 'text-status-warning',
  alerted: 'text-status-alerted',
  offline: 'text-status-offline',
}

const STATE_LABELS: Record<FocusState, string> = {
  online: strings.session.focusStates.online,
  on_break: strings.session.focusStates.onBreak,
  focused: strings.session.focusStates.focused,
  warning: strings.session.focusStates.warning,
  alerted: strings.session.focusStates.alerted,
  offline: strings.session.focusStates.offline,
}

export type FocusIndicatorProps = {
  state: FocusState
  size?: 'sm' | 'md'
  className?: string
}

export function FocusIndicator({
  state,
  size = 'sm',
  className,
}: FocusIndicatorProps) {
  const Icon = STATE_ICONS[state]
  return (
    <span
      role="img"
      aria-label={STATE_LABELS[state]}
      className={cn('inline-flex shrink-0', STATE_COLORS[state], className)}
    >
      <Icon
        aria-hidden="true"
        className={size === 'sm' ? 'size-2.5' : 'size-3'}
      />
    </span>
  )
}
