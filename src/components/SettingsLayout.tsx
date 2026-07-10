import { type ReactNode } from 'react'
import { ChevronLeftIcon } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { tokens } from '@/design/tokens'
import { cn } from '@/lib/utils'
import { strings } from '@/strings'

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
      // h-full (not min-h-screen) so the pane below actually bounds and
      // scrolls internally — min-h-screen let tall panes grow the page,
      // scrolling the header + nav rail away. The html/body/#root chain is
      // height:100%, and the custom-chrome shell sizes its scroll wrapper,
      // so 100% resolves correctly under both window styles.
      className="flex h-full flex-col bg-bg-base text-text-primary"
      aria-label={strings.settings.layoutAriaLabel}
    >
      <header className="flex shrink-0 items-center gap-4 border-b border-border-subtle px-6 py-4">
        {onClose ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={onClose}
            aria-label={strings.settings.closeAriaLabel}
          >
            <ChevronLeftIcon /> {strings.common.actions.back}
          </Button>
        ) : null}
        <h1 className="text-2xl font-semibold tracking-tight">
          {strings.settings.heading}
        </h1>
      </header>
      <div className="flex min-h-0 flex-1">
        <nav
          aria-label={strings.settings.navAriaLabel}
          className="shrink-0 overflow-y-auto border-r border-border-subtle bg-bg-surface px-3 py-6"
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
          aria-label={strings.settings.sectionAriaLabel(
            activeCategoryLabel(categories, activeCategoryId)
          )}
          className="min-w-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6 sm:py-6"
        >
          <div
            className="mx-auto flex w-full flex-col gap-8"
            style={{ maxWidth: tokens.sizes.settingsMaxWidth }}
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
  return (
    categories.find((c) => c.id === id)?.label ?? strings.settings.fallbackLabel
  )
}
