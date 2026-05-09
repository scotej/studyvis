import { cn } from '@/lib/utils'

export type FocusState = 'focused' | 'warning' | 'alerted' | 'offline'

const STATE_COLORS: Record<FocusState, string> = {
  focused: 'bg-status-focused',
  warning: 'bg-status-warning',
  alerted: 'bg-status-alerted',
  offline: 'bg-status-offline',
}

const STATE_LABELS: Record<FocusState, string> = {
  focused: 'On task',
  warning: 'Self-warning',
  alerted: 'Off task',
  offline: 'Offline',
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
