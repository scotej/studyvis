import { type ReactNode } from 'react'
import { ChevronRightIcon } from 'lucide-react'

import { cn } from '@/lib/utils'

export type DisclosureProps = {
  // Left side of the summary row (label + optional help copy).
  summary: ReactNode
  // Revealed content.
  children: ReactNode
  // Styles the <details> container (card chrome, row borders, …).
  className?: string
  // Styles the <summary> row (padding, radius) per host surface.
  summaryClassName?: string
  // Uncontrolled initial state. Storybook uses this to keep collapsed
  // content inside the axe-core gate.
  defaultOpen?: boolean
}

// Native default-collapsed disclosure shared by Settings → Network →
// Advanced and the AI model guide. Native <details> keeps keyboard and
// screen-reader behavior for free; the chevron rotation is an instant
// class swap, not a transition, per the DESIGN-SYSTEM §6 motion rules.
export function Disclosure({
  summary,
  children,
  className,
  summaryClassName,
  defaultOpen = false,
}: DisclosureProps) {
  return (
    <details
      data-slot="disclosure"
      open={defaultOpen || undefined}
      className={cn('group', className)}
    >
      <summary
        className={cn(
          'flex cursor-pointer list-none items-start justify-between gap-4 outline-none focus-visible:ring-3 focus-visible:ring-accent-ring',
          summaryClassName
        )}
      >
        {summary}
        <ChevronRightIcon
          className="mt-0.5 size-4 shrink-0 text-text-secondary group-open:rotate-90"
          aria-hidden
        />
      </summary>
      {children}
    </details>
  )
}
