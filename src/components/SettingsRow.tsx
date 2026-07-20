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
  // control slot. Used for low-contrast informational rows such as the
  // Settings → Identity "Recovery phrase" note.
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
        'flex border-b border-border-subtle py-4 last:border-b-0',
        // §12 gaps per orientation: 24px keeps an inline control clear of its
        // label; stacked controls belong to the label directly above, so the
        // inline gap (12px) reads as one unit instead of a detached block.
        stack
          ? 'flex-col gap-3'
          : 'flex-row items-center justify-between gap-6',
        disabled && 'opacity-60',
        className
      )}
    >
      <div className="flex min-w-0 flex-col gap-1">
        <span className="text-sm font-medium text-text-primary">{label}</span>
        {help ? (
          // break-words: several panes surface raw backend errors here
          // (autostart, sidecar, session history), and those routinely embed
          // unbreakable tokens — absolute paths, registry keys, URLs. Without
          // a wrap guard one long token widens the row past the content
          // column and puts a horizontal scrollbar on the whole pane.
          <span className="text-xs break-words text-text-secondary">
            {help}
          </span>
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
