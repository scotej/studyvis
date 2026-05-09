import * as React from 'react'

import { cn } from '@/lib/utils'

function Kbd({ className, ...props }: React.ComponentProps<'kbd'>) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        'inline-flex h-5 min-w-5 items-center justify-center rounded-sm border border-border-default bg-bg-raised px-1.5 font-mono text-xs leading-none text-text-secondary',
        className
      )}
      {...props}
    />
  )
}

export { Kbd }
