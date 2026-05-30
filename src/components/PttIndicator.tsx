import { Mic } from 'lucide-react'

import { cn } from '@/lib/utils'

export type PttIndicatorProps = {
  active: boolean
  className?: string
}

export function PttIndicator({ active, className }: PttIndicatorProps) {
  // Decorative color+icon affordance: the local user holding the key already
  // knows they're transmitting, and narrating every peer's PTT toggle would
  // flood a screen reader. aria-hidden keeps it out of the accessibility tree.
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-flex items-center justify-center rounded-full bg-accent-default p-1.5 text-text-inverse transition-opacity duration-fast',
        active ? 'opacity-100' : 'opacity-0',
        className
      )}
    >
      <Mic className="size-3.5" strokeWidth={1.5} aria-hidden="true" />
    </span>
  )
}
