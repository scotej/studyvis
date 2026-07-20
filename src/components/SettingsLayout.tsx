import {
  type KeyboardEvent,
  type ReactNode,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react'
import { ChevronLeftIcon, SearchIcon, XIcon } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
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
  // Extra terms the nav search matches beyond the label + group — the
  // concepts a pane owns (e.g. 'theme', 'dark' for Appearance), so a setting
  // is findable by what it does, not just the pane's name. Supplied by the
  // container to keep this layout free of feature copy.
  keywords?: readonly string[]
}

export type SettingsLayoutProps<TId extends string = string> = {
  categories: ReadonlyArray<SettingsCategoryDescriptor<TId>>
  activeCategoryId: TId
  onCategorySelect: (id: TId) => void
  onClose?: () => void
  // Initial nav-search query. Initial only, like Settings' initialCategory —
  // lets a story exhibit the filtered / no-results states and leaves room to
  // deep-link a search later. Defaults to empty (the full list).
  initialQuery?: string
  children: ReactNode
}

// Matches when every whitespace-separated token of the query appears in the
// pane's label, group, or one of its keywords. Tokenised rather than one
// contiguous substring so natural multi-word queries like "window size"
// resolve — the tokens are free to land in different keywords.
function categoryMatches(
  category: SettingsCategoryDescriptor,
  query: string
): boolean {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return true
  const haystacks = [
    category.label.toLowerCase(),
    category.group?.toLowerCase() ?? '',
    ...(category.keywords ?? []).map((k) => k.toLowerCase()),
  ]
  return tokens.every((token) => haystacks.some((h) => h.includes(token)))
}

// Composed surface for the V1 settings panel (DESIGN-SYSTEM.md §8.5). Pure
// props — no store or feature imports. Container lives in
// `src/features/settings/Settings.tsx`.
export function SettingsLayout<TId extends string = string>({
  categories,
  activeCategoryId,
  onCategorySelect,
  onClose,
  initialQuery = '',
  children,
}: SettingsLayoutProps<TId>) {
  const [query, setQuery] = useState(initialQuery)
  const trimmedQuery = query.trim()
  const filtered = useMemo(
    () => categories.filter((c) => categoryMatches(c, trimmedQuery)),
    [categories, trimmedQuery]
  )

  const searchRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  // Unique so aria-controls stays valid even if two rails ever coexist.
  const listId = useId()

  // Keyboard flow across the rail: type, ArrowDown into the list, arrow
  // through items, ArrowUp off the top back to the field. Focus moves over
  // the rendered buttons directly (they are the only nav items in the list),
  // so it always tracks the current filtered set with no index state to sync.
  function focusItem(index: number) {
    const items = listRef.current?.querySelectorAll<HTMLButtonElement>(
      'button[data-nav-item]'
    )
    if (!items || items.length === 0) return
    const clamped = Math.max(0, Math.min(index, items.length - 1))
    items[clamped]?.focus()
  }

  function handleSearchKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      focusItem(0)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      if (filtered.length > 0) onCategorySelect(filtered[0].id)
    } else if (event.key === 'Escape' && query !== '') {
      // Clear the query rather than letting Escape bubble up to close the
      // whole Settings overlay — a search in progress is the nearer thing to
      // dismiss. An empty field lets Escape through to close as before.
      event.preventDefault()
      event.stopPropagation()
      setQuery('')
    }
  }

  function handleItemKeyDown(
    event: KeyboardEvent<HTMLButtonElement>,
    index: number
  ) {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      focusItem(index + 1)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      if (index === 0) searchRef.current?.focus()
      else focusItem(index - 1)
    } else if (event.key === 'Home') {
      event.preventDefault()
      focusItem(0)
    } else if (event.key === 'End') {
      event.preventDefault()
      focusItem(filtered.length - 1)
    }
  }

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
          <div className="relative mb-2">
            <SearchIcon
              size={16}
              strokeWidth={1.5}
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-text-muted"
            />
            <Input
              ref={searchRef}
              type="text"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={handleSearchKeyDown}
              placeholder={strings.settings.search.placeholder}
              aria-label={strings.settings.search.ariaLabel}
              // Only reference the list when it exists — the no-results branch
              // drops the <ul>, and a dangling aria-controls id is invalid.
              aria-controls={filtered.length > 0 ? listId : undefined}
              autoComplete="off"
              spellCheck={false}
              className="px-9"
            />
            {query !== '' ? (
              <button
                type="button"
                onClick={() => {
                  setQuery('')
                  searchRef.current?.focus()
                }}
                aria-label={strings.settings.search.clearAriaLabel}
                className="absolute top-1/2 right-2 -translate-y-1/2 rounded-sm p-0.5 text-text-muted outline-none transition-colors hover:text-text-primary focus-visible:ring-3 focus-visible:ring-accent-ring"
              >
                <XIcon size={14} strokeWidth={1.5} aria-hidden="true" />
              </button>
            ) : null}
          </div>
          {/* Announce the result count as the query narrows. The no-results
              line below is its own polite status, so this count region stays
              out of the empty case to avoid announcing the same fact twice. */}
          {trimmedQuery !== '' && filtered.length > 0 ? (
            <p className="sr-only" role="status" aria-live="polite">
              {strings.settings.search.resultCount(filtered.length)}
            </p>
          ) : null}
          {filtered.length === 0 ? (
            <p
              role="status"
              aria-live="polite"
              className="px-3 py-2 text-sm text-text-secondary"
            >
              {strings.settings.search.noResults}
            </p>
          ) : (
            <ul id={listId} ref={listRef} className="flex flex-col gap-0.5">
              {filtered.map((category, index) => {
                const active = category.id === activeCategoryId
                const previousGroup =
                  index > 0 ? filtered[index - 1].group : undefined
                const showGroup =
                  category.group !== undefined &&
                  category.group !== previousGroup
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
                      data-nav-item
                      onClick={() => onCategorySelect(category.id)}
                      onKeyDown={(event) => handleItemKeyDown(event, index)}
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
          )}
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
