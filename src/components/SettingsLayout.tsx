import { type ReactNode } from 'react'
import { ChevronLeftIcon } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { tokens } from '@/design/tokens'
import { cn } from '@/lib/utils'

export type SettingsCategoryDescriptor<TId extends string = string> = {
  id: TId
  label: string
}

export type SettingsLayoutProps<TId extends string = string> = {
  categories: ReadonlyArray<SettingsCategoryDescriptor<TId>>
  activeCategoryId: TId
  onCategorySelect: (id: TId) => void
  onClose?: () => void
  children: ReactNode
}

// Composed surface for the V1 settings panel (DESIGN-SYSTEM.md §8.5). Pure
// props — no store or feature imports. Container lives in
// `src/features/settings/Settings.tsx`.
export function SettingsLayout<TId extends string = string>({
  categories,
  activeCategoryId,
  onCategorySelect,
  onClose,
  children,
}: SettingsLayoutProps<TId>) {
  return (
    <main
      data-slot="settings-layout"
      className="flex min-h-screen flex-col bg-bg-base text-text-primary"
      aria-label="Settings"
    >
      <header className="flex items-center gap-4 border-b border-border-subtle px-6 py-4">
        {onClose ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={onClose}
            aria-label="Close settings"
          >
            <ChevronLeftIcon /> Back
          </Button>
        ) : null}
        <h1 className="text-lg font-semibold tracking-tight">Settings</h1>
      </header>
      <div className="flex flex-1">
        <nav
          aria-label="Settings categories"
          className="shrink-0 border-r border-border-subtle bg-bg-surface px-3 py-6"
          style={{ width: tokens.sizes.sidebarWidth }}
        >
          <ul className="flex flex-col gap-1">
            {categories.map((category) => {
              const active = category.id === activeCategoryId
              return (
                <li key={category.id}>
                  <button
                    type="button"
                    onClick={() => onCategorySelect(category.id)}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'flex w-full items-center justify-start rounded-md px-3 py-2 text-left text-sm transition-colors outline-none focus-visible:ring-3 focus-visible:ring-accent-ring',
                      active
                        ? 'bg-bg-raised font-medium text-text-primary'
                        : 'text-text-secondary hover:bg-bg-raised hover:text-text-primary'
                    )}
                  >
                    {category.label}
                  </button>
                </li>
              )
            })}
          </ul>
        </nav>
        <section
          aria-label={`${activeCategoryLabel(categories, activeCategoryId)} settings`}
          className="min-w-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6 sm:py-6"
        >
          <div
            className="mx-auto flex w-full flex-col gap-8"
            style={{ maxWidth: tokens.sizes.contentMaxWidth }}
          >
            {children}
          </div>
        </section>
      </div>
    </main>
  )
}

function activeCategoryLabel<TId extends string>(
  categories: ReadonlyArray<SettingsCategoryDescriptor<TId>>,
  id: TId
): string {
  return categories.find((c) => c.id === id)?.label ?? 'Settings'
}
