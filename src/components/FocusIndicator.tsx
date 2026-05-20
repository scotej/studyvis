import { cn } from '@/lib/utils'
import { strings } from '@/strings'

export type V1FocusState = 'online' | 'on_break' | 'offline'
export type V2FocusState = 'focused' | 'warning' | 'alerted' | 'offline'
export type FocusState = V1FocusState | V2FocusState

const STATE_COLORS: Record<FocusState, string> = {
  online: 'bg-status-online',
  on_break: 'bg-status-warning',
  focused: 'bg-status-focused',
  warning: 'bg-status-warning',
  alerted: 'bg-status-alerted',
  offline: 'bg-transparent border-2 border-status-offline',
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
  return (
    <span
      role="img"
      aria-label={STATE_LABELS[state]}
      className={cn(
        'inline-flex shrink-0 rounded-full',
        size === 'sm' ? 'size-2.5' : 'size-3',
        STATE_COLORS[state],
        className
      )}
    />
  )
}
