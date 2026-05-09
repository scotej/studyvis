import { Children, type ReactNode } from 'react'

import { cn } from '@/lib/utils'

export type VideoGridProps = {
  children: ReactNode
  className?: string
}

// Grid layout for 1–4 tiles. Mesh hard-caps at 4 (ARCHITECTURE.md §7); fifths
// are evicted at the host before they ever land here. Plain semantic group
// — `role="grid"` would imply gridcells/keyboard navigation we don't yet
// implement; the V3 accessibility pass can revisit.
export function VideoGrid({ children, className }: VideoGridProps) {
  const count = Children.count(children)
  const layout =
    count <= 1
      ? 'grid-cols-1'
      : count === 3
        ? 'grid-cols-2 md:grid-cols-3'
        : 'grid-cols-2'
  return (
    <div
      role="group"
      aria-label="Session participants"
      className={cn('grid gap-4', layout, className)}
      data-tile-count={count}
    >
      {children}
    </div>
  )
}
