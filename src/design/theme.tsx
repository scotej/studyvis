import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
} from 'react'
import type { ReactNode } from 'react'

import { ThemeContext, type ThemeMode } from '@/design/theme-context'
import { useSettingsStore } from '@/stores/settingsStore'

function applyClass(resolved: 'dark' | 'light') {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  if (resolved === 'light') {
    root.classList.add('light')
  } else {
    root.classList.remove('light')
  }
  root.dataset.theme = resolved
}

function detectSystem(): 'dark' | 'light' {
  if (typeof window === 'undefined' || !window.matchMedia) return 'dark'
  return window.matchMedia('(prefers-color-scheme: light)').matches
    ? 'light'
    : 'dark'
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

  const [system, setSystem] = useState<'dark' | 'light'>(() => detectSystem())

  useEffect(() => {
    void hydrateSettings()
  }, [hydrateSettings])

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const mq = window.matchMedia('(prefers-color-scheme: light)')
    const onChange = () => setSystem(mq.matches ? 'light' : 'dark')
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  const resolved: 'dark' | 'light' = mode === 'auto' ? system : mode

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
