import { Children, type ReactNode } from 'react'

import { cn } from '@/lib/utils'
import { strings } from '@/strings'

// Grid layout for the session tiles. The mesh hard-caps at 4 people
// (ARCHITECTURE.md §7) and #96 lets each of them publish a screen alongside
// their camera, so the child count now runs 1–8 rather than 1–4. Plain semantic
// group — `role="grid"` would imply gridcells/keyboard navigation we don't yet
// implement; the V3 accessibility pass can revisit.
export type VideoGridProps = {
  children: ReactNode
  className?: string
}

// Column count by tile count. Past four tiles the pairs-of-two layout leaves
// every tile a thin strip on a laptop screen, so the grid widens instead of
// growing taller — screens in particular are unreadable when squeezed.
function columnsFor(count: number): string {
  if (count <= 1) return 'grid-cols-1'
  if (count === 3) return 'grid-cols-2 md:grid-cols-3'
  if (count <= 4) return 'grid-cols-2'
  if (count <= 6) return 'grid-cols-2 md:grid-cols-3'
  return 'grid-cols-2 md:grid-cols-3 xl:grid-cols-4'
}

export function VideoGrid({ children, className }: VideoGridProps) {
  const count = Children.count(children)
  return (
    <div
      role="group"
      aria-label={strings.session.gridAriaLabel}
      className={cn('grid gap-4', columnsFor(count), className)}
      data-tile-count={count}
    >
      {children}
    </div>
  )
}
