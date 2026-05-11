// V2-P8 — Icon + tone mapping for AuditLogRow + Report timeline rows. Lives
// in `lib/` (not `features/session/`) so the primitive AuditLogRow in
// `components/` can import it — the component layer is forbidden from
// reaching into `features/`. Both surfaces read from this single map so
// the V2-P6/V2-P7 audit kinds render with consistent icons.

import {
  AlertOctagonIcon,
  AlertTriangleIcon,
  BookOpenIcon,
  CheckIcon,
  CoffeeIcon,
  LogInIcon,
  LogOutIcon,
  PauseIcon,
  PlayIcon,
  RefreshCwIcon,
  TimerIcon,
  TimerOffIcon,
  XIcon,
  type LucideIcon,
} from 'lucide-react'

import type { AuditEventKind } from '@/lib/audit-types'

export const AUDIT_ICONS: Record<AuditEventKind, LucideIcon> = {
  joined: LogInIcon,
  left: LogOutIcon,
  paused_break: PauseIcon,
  resumed: PlayIcon,
  pomodoro_start: TimerIcon,
  pomodoro_end: TimerOffIcon,
  ai_warning: AlertTriangleIcon,
  ai_alert: AlertOctagonIcon,
  topic_set: BookOpenIcon,
  topic_change: RefreshCwIcon,
  break_request: CoffeeIcon,
  break_approved: CheckIcon,
  break_denied: XIcon,
}

// Tone modulates the icon's color via Tailwind classes. The AuditLogRow
// and Report timeline both read this to apply per-kind styling without
// duplicating the lookup.
export type AuditIconTone =
  | 'default'
  | 'warning'
  | 'alerted'
  | 'focused'
  | 'accent'

export const AUDIT_ICON_TONE: Record<AuditEventKind, AuditIconTone> = {
  joined: 'default',
  left: 'default',
  paused_break: 'default',
  resumed: 'focused',
  pomodoro_start: 'accent',
  pomodoro_end: 'default',
  ai_warning: 'warning',
  ai_alert: 'alerted',
  topic_set: 'accent',
  topic_change: 'accent',
  break_request: 'default',
  break_approved: 'focused',
  break_denied: 'alerted',
}
