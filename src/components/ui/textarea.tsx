import * as React from "react"

import { cn } from "@/lib/utils"

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex field-sizing-content min-h-16 w-full rounded-md border border-border-default bg-transparent px-3 py-2 text-base shadow-xs transition-[color,box-shadow] outline-none placeholder:text-text-secondary focus-visible:border-accent-default focus-visible:ring-[3px] focus-visible:ring-accent-ring disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-status-alerted aria-invalid:ring-status-alerted md:text-sm ",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
