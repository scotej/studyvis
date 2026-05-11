import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import {
  AUDIT_ICONS,
  AUDIT_ICON_TONE,
  type AuditIconTone,
} from '@/lib/audit-icons'
import type { AuditEventKind } from '@/lib/audit-types'
import { cn } from '@/lib/utils'

export type AuditLogRowProps = {
  name: string
  // Already-resolved action label (e.g. "joined", "took a break"). Mapping
  // from event kind → label is the feature layer's job; the component layer
  // is intentionally agnostic so V2's expanded kind set requires no change
  // to this primitive.
  description: string
  // Absolute timestamp in ms. Rendered as relative ("5s ago") in the row.
  ts: number
  // Current wall-clock ms used to compute the "ago" string. Required so the
  // component is pure during render — the panel ticks this and re-passes.
  now: number
  // Optional context shown on hover (and to screen readers) — V2-P6 routes
  // the AI judgement reasoning here so off-task events surface the "why"
  // without claiming a permanent slot in the row. Empty string disables.
  hoverDetail?: string
  // Optional audit-event kind. When supplied the row swaps its avatar dot
  // for a kind-specific icon (V2-P8) — V2-P6 covered ai_warning/ai_alert
  // tooltips but not distinct icons. Omitting it falls back to the V1
  // avatar-initials rendering so legacy stories stay visually identical.
  iconKind?: AuditEventKind
  className?: string
}

// Single audit-log row — small avatar/icon, "<name> <description>", relative
// timestamp per DESIGN-SYSTEM.md §8.3. V2-P8 added the per-kind icon mode.
export function AuditLogRow({
  name,
  description,
  ts,
  now,
  hoverDetail,
  iconKind,
  className,
}: AuditLogRowProps) {
  const initials = makeInitials(name)
  const hover = hoverDetail?.trim() || undefined
  const Icon = iconKind ? AUDIT_ICONS[iconKind] : null
  const tone: AuditIconTone = iconKind ? AUDIT_ICON_TONE[iconKind] : 'default'
  return (
    <li
      className={cn(
        'flex items-start gap-3 px-4 py-2.5 text-sm',
        'border-b border-border-subtle last:border-b-0',
        className
      )}
      data-testid="audit-log-row"
      title={hover}
      aria-description={hover}
    >
      {Icon ? (
        <span
          aria-hidden="true"
          className={cn(
            'mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-full',
            toneClassName(tone)
          )}
        >
          <Icon className="size-3.5" />
        </span>
      ) : (
        <Avatar size="sm" aria-hidden="true">
          <AvatarFallback>{initials}</AvatarFallback>
        </Avatar>
      )}
      <div className="flex min-w-0 flex-1 flex-col leading-snug">
        <span className="truncate text-text-primary">
          <span className="font-medium">{name}</span>
          <span className="text-text-secondary"> {description}</span>
        </span>
        <time
          dateTime={new Date(ts).toISOString()}
          className="text-xs text-text-muted"
        >
          {formatAgo(ts, now)}
        </time>
      </div>
    </li>
  )
}

function toneClassName(tone: AuditIconTone): string {
  switch (tone) {
    case 'warning':
      return 'bg-status-warning/15 text-status-warning'
    case 'alerted':
      return 'bg-status-alerted/15 text-status-alerted'
    case 'focused':
      return 'bg-status-focused/15 text-status-focused'
    case 'accent':
      return 'bg-accent-default/15 text-accent-default'
    default:
      return 'bg-bg-raised text-text-secondary'
  }
}

function makeInitials(name: string): string {
  const trimmed = name.trim()
  if (!trimmed) return '?'
  const parts = trimmed.split(/\s+/)
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[1][0]).toUpperCase()
}

function formatAgo(ts: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - ts) / 1000))
  if (seconds < 5) return 'just now'
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ago`
}
