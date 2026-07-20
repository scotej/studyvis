import { type ReactNode } from 'react'
import { ChevronLeftIcon } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { tokens } from '@/design/tokens'
import { cn } from '@/lib/utils'
import { strings } from '@/strings'

export type SettingsCategoryDescriptor<TId extends string = string> = {
  id: TId
  label: string
  // Optional 16px lucide glyph rendered before the label (DESIGN-SYSTEM §9:
  // stroke 1.5, currentColor). Supplied by the container so this layout
  // stays free of feature knowledge.
  icon?: ReactNode
  // Optional group heading. The list stays flat; a heading is rendered
  // above an item whenever its group differs from the previous item's, so
  // one array remains the single source of order and grouping.
  group?: string
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
          // Fluid rail: clamp(settingsRailMinWidth, 22vw, sidebarWidth) via
          // --settings-rail-width (src/design/index.css) — a fixed 280 was
          // 27% of the window at the 1024 minimum and starved the content
          // column below its 768 measure. py-4 (not py-6) keeps all eleven
          // grouped items visible at the 640px window-height minimum.
          className="w-(--settings-rail-width) shrink-0 overflow-y-auto border-r border-border-subtle bg-bg-surface px-3 py-4"
        >
          <ul className="flex flex-col gap-0.5">
            {categories.map((category, index) => {
              const active = category.id === activeCategoryId
              const previousGroup =
                index > 0 ? categories[index - 1].group : undefined
              const showGroup =
                category.group !== undefined && category.group !== previousGroup
              return (
                <li key={category.id}>
                  {showGroup ? (
                    <div
                      className={cn(
                        'px-3 pb-1 text-xs font-medium tracking-wide text-text-muted uppercase',
                        index > 0 && 'pt-3'
                      )}
                    >
                      {category.group}
                    </div>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => onCategorySelect(category.id)}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'relative flex w-full items-center gap-3 rounded-md px-3 py-1.5 text-left text-sm transition-colors outline-none focus-visible:ring-3 focus-visible:ring-accent-ring',
                      active
                        ? 'bg-bg-raised font-medium text-text-primary'
                        : 'text-text-secondary hover:bg-bg-raised hover:text-text-primary'
                    )}
                  >
                    {active ? (
                      // Accent edge on top of the bg + weight treatment —
                      // additive, so the active state never rides color
                      // alone (§11).
                      <span
                        aria-hidden="true"
                        className="absolute inset-y-1 left-0 w-0.5 rounded-full bg-accent-default"
                      />
                    ) : null}
                    {category.icon}
                    {category.label}
                  </button>
                </li>
              )
            })}
          </ul>
        </nav>
        <section
          // Keyed so switching category remounts the scroll container —
          // otherwise a pane opened after scrolling a tall one starts
          // pre-scrolled with its heading above the fold.
          key={activeCategoryId}
          aria-label={strings.settings.sectionAriaLabel(
            activeCategoryLabel(categories, activeCategoryId)
          )}
          // scrollbar-gutter reserves space on BOTH edges so the centered
          // column neither shifts when a tall pane adds a classic
          // (non-overlay) scrollbar on Windows nor sits off the header's
          // optical center while the gutter is reserved.
          className="min-w-0 flex-1 overflow-y-auto px-6 py-6 [scrollbar-gutter:stable_both-edges]"
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
