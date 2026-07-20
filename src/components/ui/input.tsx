import * as React from 'react'

import { cn } from '@/lib/utils'

function Input({ className, type, ...props }: React.ComponentProps<'input'>) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        'h-9 w-full min-w-0 rounded-md border border-border-default bg-transparent px-3 py-1 text-sm shadow-xs transition-[color,box-shadow] outline-none selection:bg-accent-default selection:text-text-inverse file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-text-primary placeholder:text-text-secondary disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 ',
        'focus-visible:border-accent-default focus-visible:ring-3 focus-visible:ring-accent-ring',
        'aria-invalid:border-status-alerted aria-invalid:ring-status-alerted ',
        className
      )}
      {...props}
    />
  )
}

export { Input }
