import { Mic } from 'lucide-react'

import { cn } from '@/lib/utils'

export type PttIndicatorProps = {
  active: boolean
  className?: string
}

export function PttIndicator({ active, className }: PttIndicatorProps) {
  return (
    <span
      aria-hidden={!active}
      aria-label={active ? 'Transmitting' : undefined}
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
