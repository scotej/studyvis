import {
  AlertCircle,
  Circle,
  CircleDashed,
  CircleDot,
  CircleOff,
  Coffee,
  TriangleAlert,
  Unplug,
  type LucideIcon,
} from 'lucide-react'

import { cn } from '@/lib/utils'
import { strings } from '@/strings'

export type V1FocusState = 'online' | 'on_break' | 'offline'
export type V2FocusState = 'focused' | 'warning' | 'alerted' | 'offline'
// F4 — WebRTC transport states for peer tiles. Distinct from the focus
// states above; surfaced when a peer is mid-handshake or its connection
// failed so a frozen offline tile is no longer ambiguous.
export type ConnectionFocusState = 'connecting' | 'failed'
export type FocusState = V1FocusState | V2FocusState | ConnectionFocusState

// Each state gets a grayscale-distinct glyph so the status reads without
// relying on color (WCAG 1.4.1). `online` (hollow ring) and `focused`
// (filled center) share a token color but differ by shape; `warning`
// (circle), `alerted` (triangle), and `on_break` (cup) are tellable apart by
// silhouette alone. F4 adds `connecting` (dashed ring) and `failed` (unplug)
// — both shape-distinct from the rest. Icon precedents:
// SelfWarningBadge=AlertCircle, BreakCountdownBadge=Coffee.
const STATE_ICONS: Record<FocusState, LucideIcon> = {
  online: Circle,
  on_break: Coffee,
  focused: CircleDot,
  warning: AlertCircle,
  alerted: TriangleAlert,
  offline: CircleOff,
  connecting: CircleDashed,
  failed: Unplug,
}

// F4 reuses existing status tokens rather than minting new ones: `connecting`
// shares the amber `status-warning` (in-progress) and `failed` shares the red
// `status-alerted` (problem) — both pairings already clear WCAG AA in
// check-contrast.ts.
const STATE_COLORS: Record<FocusState, string> = {
  online: 'text-status-online',
  on_break: 'text-status-warning',
  focused: 'text-status-focused',
  warning: 'text-status-warning',
  alerted: 'text-status-alerted',
  offline: 'text-status-offline',
  connecting: 'text-status-warning',
  failed: 'text-status-alerted',
}

const STATE_LABELS: Record<FocusState, string> = {
  online: strings.session.focusStates.online,
  on_break: strings.session.focusStates.onBreak,
  focused: strings.session.focusStates.focused,
  warning: strings.session.focusStates.warning,
  alerted: strings.session.focusStates.alerted,
  offline: strings.session.focusStates.offline,
  connecting: strings.session.focusStates.connecting,
  failed: strings.session.focusStates.failed,
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
