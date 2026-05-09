import { Avatar, AvatarFallback } from '@/components/ui/avatar'
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
  className?: string
}

// Single audit-log row — small avatar, "<name> <description>", relative
// timestamp per DESIGN-SYSTEM.md §8.3.
export function AuditLogRow({
  name,
  description,
  ts,
  now,
  className,
}: AuditLogRowProps) {
  const initials = makeInitials(name)
  return (
    <li
      className={cn(
        'flex items-start gap-3 px-4 py-2.5 text-sm',
        'border-b border-border-subtle last:border-b-0',
        className
      )}
      data-testid="audit-log-row"
    >
      <Avatar size="sm" aria-hidden="true">
        <AvatarFallback>{initials}</AvatarFallback>
      </Avatar>
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
