import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
} from 'react'
import type { ReactNode } from 'react'

import { ThemeContext, type ThemeMode } from '@/design/theme-context'
import { resolveTheme, type ResolvedTheme } from '@/design/theme-resolution'
import {
  THEME_LOCALSTORAGE_KEY,
  useSettingsStore,
} from '@/stores/settingsStore'

function applyClass(resolved: ResolvedTheme) {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  if (resolved === 'light') {
    root.classList.add('light')
  } else {
    root.classList.remove('light')
  }
  root.dataset.theme = resolved
}

function detectSystem(): ResolvedTheme {
  if (typeof window === 'undefined' || !window.matchMedia) return 'dark'
  return window.matchMedia('(prefers-color-scheme: light)').matches
    ? 'light'
    : 'dark'
}

function readThemeBootCache(): ThemeMode {
  if (typeof window === 'undefined') return 'dark'
  try {
    const mode = window.localStorage.getItem(THEME_LOCALSTORAGE_KEY)
    return mode === 'dark' || mode === 'light' || mode === 'auto'
      ? mode
      : 'dark'
  } catch {
    // The persistent store remains authoritative in the main window. The AI
    // dialog has no store hydration, so fall back to the shipped default if
    // its cross-window boot cache is unavailable.
    return 'dark'
  }
}

function useSystemTheme(): ResolvedTheme {
  const [system, setSystem] = useState<ResolvedTheme>(() => detectSystem())

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const mq = window.matchMedia('(prefers-color-scheme: light)')
    const onChange = () => setSystem(mq.matches ? 'light' : 'dark')
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  return system
}

// The floating AI dialog intentionally does not hydrate the settings store:
// it is a separate, least-privileged webview and only needs the synchronous
// theme cache. A storage event is delivered to other same-origin windows when
// the main window changes Appearance → Theme.
function useThemeBootCache(): ThemeMode {
  const [mode, setMode] = useState<ThemeMode>(readThemeBootCache)

  useEffect(() => {
    if (typeof window === 'undefined') return
    const onStorage = (event: StorageEvent) => {
      // `null` is the standard key for localStorage.clear(), which should
      // restore the dialog to the shipped dark default too.
      if (event.key === THEME_LOCALSTORAGE_KEY || event.key === null) {
        setMode(readThemeBootCache())
      }
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  return mode
}

// Mount this in a secondary webview that shares the main window's origin but
// not its React/Zustand realm. It reacts both to Appearance changes (storage)
// and to the OS light/dark preference while the saved mode is `auto`.
export function ApplyThemeBootCache(): null {
  const mode = useThemeBootCache()
  const system = useSystemTheme()
  const resolved = resolveTheme(mode, system)

  useLayoutEffect(() => {
    applyClass(resolved)
  }, [resolved])

  return null
}

export function ThemeProvider({
  children,
  defaultMode,
}: {
  children: ReactNode
  defaultMode?: ThemeMode
}) {
  const themeFromStore = useSettingsStore((s) => s.values.theme)
  const settingsStatus = useSettingsStore((s) => s.status)
  const setThemeInStore = useSettingsStore((s) => s.setTheme)
  const hydrateSettings = useSettingsStore((s) => s.hydrate)

  // Until the persistent store hydrates, fall back to the optional
  // `defaultMode` prop (Storybook uses "dark"). Once status flips to "ready",
  // `themeFromStore` becomes the source of truth.
  const mode: ThemeMode =
    settingsStatus === 'ready' ? themeFromStore : (defaultMode ?? 'dark')

  const system = useSystemTheme()

  useEffect(() => {
    void hydrateSettings()
  }, [hydrateSettings])

  const resolved = resolveTheme(mode, system)

  // PR-28 — before the persistent store hydrates (production has no
  // `defaultMode`), `mode` falls back to 'dark'. Writing that here would strip
  // the `light` class the index.html pre-paint script already set from the
  // theme boot cache, flashing dark for light/auto-on-light users until
  // hydration lands. So only touch the class once we have an authoritative
  // mode: the store is ready, or a defaultMode was passed (Storybook). Until
  // then, defer to the boot script's class.
  const hasAuthoritativeMode =
    settingsStatus === 'ready' || defaultMode !== undefined

  const useIsoLayoutEffect =
    typeof window === 'undefined' ? useEffect : useLayoutEffect
  useIsoLayoutEffect(() => {
    if (!hasAuthoritativeMode) return
    applyClass(resolved)
  }, [resolved, hasAuthoritativeMode])

  const setMode = useCallback(
    (next: ThemeMode) => {
      // Fire-and-forget: the settings store mutates state synchronously, so
      // the UI reflects the change on the next render even if the LazyStore
      // write is in flight.
      void setThemeInStore(next)
    },
    [setThemeInStore]
  )

  const value = useMemo(
    () => ({ mode, resolved, setMode }),
    [mode, resolved, setMode]
  )

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}
