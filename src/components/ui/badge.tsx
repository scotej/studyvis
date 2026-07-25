import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { Slot } from 'radix-ui'

import { cn } from '@/lib/utils'

const badgeVariants = cva(
  'inline-flex w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-full border border-transparent px-2 py-0.5 text-xs font-medium whitespace-nowrap transition-[color,box-shadow] focus-visible:border-accent-default focus-visible:ring-3 focus-visible:ring-accent-ring aria-invalid:border-status-alerted aria-invalid:ring-status-alerted [&>svg]:pointer-events-none [&>svg]:size-3',
  {
    variants: {
      variant: {
        default:
          'bg-accent-default text-text-inverse [a&]:hover:bg-accent-hover',
        secondary: 'bg-bg-raised text-text-primary [a&]:hover:bg-bg-surface',
        destructive:
          'bg-status-alerted text-text-inverse focus-visible:ring-status-alerted [a&]:hover:bg-status-alerted',
        outline:
          'border-border-default text-text-primary [a&]:hover:bg-bg-raised [a&]:hover:text-text-primary',
        ghost: '[a&]:hover:bg-bg-raised [a&]:hover:text-text-primary',
        link: 'text-accent-default underline-offset-4 [a&]:hover:underline',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  }
)

function Badge({
  className,
  variant = 'default',
  asChild = false,
  ...props
}: React.ComponentProps<'span'> &
  VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : 'span'

  return (
    <Comp
      data-slot="badge"
      data-variant={variant}
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  )
}

export { Badge, badgeVariants }
