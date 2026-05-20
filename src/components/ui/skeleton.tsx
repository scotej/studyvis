import * as React from 'react'

import { cn } from '@/lib/utils'

// V3-P8 — shadcn-canonical Skeleton primitive (vendored). Replaces the
// hand-rolled `animate-pulse bg-bg-raised` blocks that drifted across
// Dashboard, SessionsCategory, Report, AddFriendDialogView, and
// ModelPicker. The reduce-motion kill switch in index.css already
// freezes `animate-pulse` to a single-frame solid block, so Skeleton
// inherits §11 reduced-motion compliance for free.
function Skeleton({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="skeleton"
      className={cn('animate-pulse rounded-md bg-bg-raised', className)}
      {...props}
    />
  )
}

export { Skeleton }
