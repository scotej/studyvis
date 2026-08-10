import type { ThemeMode } from '@/design/theme-context'

export type ResolvedTheme = 'dark' | 'light'

// Kept pure so the auto-mode contract is covered without a browser harness:
// an explicit theme always wins, while auto follows the live OS preference.
export function resolveTheme(
  mode: ThemeMode,
  system: ResolvedTheme
): ResolvedTheme {
  return mode === 'auto' ? system : mode
}
