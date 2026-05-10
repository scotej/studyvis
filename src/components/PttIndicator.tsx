import { Mic } from 'lucide-react'

import { cn } from '@/lib/utils'

export type PttIndicatorProps = {
  active: boolean
  className?: string
}

export function PttIndicator({ active, className }: PttIndicatorProps) {
  // Decorative: parent surfaces (VideoTile, audit log) already announce PTT
  // state via the peer-row label and audit events. Keeping aria-hidden stable
  // avoids screen readers tracking the opacity-faded element across toggles.
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
