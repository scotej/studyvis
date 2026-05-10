import { type ReactNode } from 'react'

import { cn } from '@/lib/utils'

export type SettingsRowProps = {
  label: ReactNode
  help?: ReactNode
  control?: ReactNode
  // Stack the control under the label instead of placing it to the right.
  // Used for radio groups / multi-line controls where the inline layout
  // would be cramped.
  stack?: boolean
  className?: string
  // Renders the row at low contrast and disables pointer events on the
  // control slot. Used for "Show backup mnemonic" (V3 deferral) and for the
  // "Coming soon" rebind shortcut row.
  disabled?: boolean
}

// Pure presentational primitive (DESIGN-SYSTEM.md §4 inventory). Renders a
// labeled row with optional helper text and a control on the right (or
// stacked below for wider controls). No store or feature imports.
export function SettingsRow({
  label,
  help,
  control,
  stack = false,
  className,
  disabled = false,
}: SettingsRowProps) {
  return (
    <div
      data-slot="settings-row"
      data-disabled={disabled || undefined}
      className={cn(
        'flex gap-6 border-b border-border-subtle py-4 last:border-b-0',
        stack ? 'flex-col' : 'flex-row items-center justify-between',
        disabled && 'opacity-60',
        className
      )}
    >
      <div className="flex min-w-0 flex-col gap-1">
        <span className="text-sm font-medium text-text-primary">{label}</span>
        {help ? (
          <span className="text-xs text-text-secondary">{help}</span>
        ) : null}
      </div>
      {control ? (
        <div
          data-slot="settings-row-control"
          className={cn(
            stack ? 'self-stretch' : 'shrink-0',
            disabled && 'pointer-events-none'
          )}
        >
          {control}
        </div>
      ) : null}
    </div>
  )
}

export function SettingsSection({
  heading,
  children,
}: {
  heading: ReactNode
  children: ReactNode
}) {
  return (
    <section className="flex flex-col">
      <h2 className="mb-3 text-xl font-semibold tracking-tight text-text-primary">
        {heading}
      </h2>
      <div className="flex flex-col">{children}</div>
    </section>
  )
}
