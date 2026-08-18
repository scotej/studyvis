import { Mic } from 'lucide-react'

import { cn } from '@/lib/utils'

export type PttIndicatorProps = {
  active: boolean
  // Which participant this badge belongs to. Read by the #226 render probe;
  // 'peer' by default so only the local tile has to opt in.
  scope?: 'self' | 'peer'
  className?: string
}

export function PttIndicator({
  active,
  scope = 'peer',
  className,
}: PttIndicatorProps) {
  // Decorative color+icon affordance: the local user holding the key already
  // knows they're transmitting, and narrating every peer's PTT toggle would
  // flood a screen reader. aria-hidden keeps it out of the accessibility tree.
  //
  // The data-* attributes are the only record of what was actually committed
  // to the DOM (#226): every other PTT record is derived from the store this
  // badge is meant to be showing, so a render fault could not be seen. They
  // carry no styling and do not enter the accessibility tree.
  return (
    <span
      aria-hidden="true"
      data-ptt-indicator=""
      data-ptt-active={String(active)}
      data-ptt-scope={scope}
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
