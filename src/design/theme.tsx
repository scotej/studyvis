import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
} from 'react'
import type { ReactNode } from 'react'

import { ThemeContext, type ThemeMode } from '@/design/theme-context'

const STORAGE_KEY = 'studyvis.theme'

function readStored(): ThemeMode {
  if (typeof window === 'undefined') return 'dark'
  const v = window.localStorage.getItem(STORAGE_KEY)
  if (v === 'dark' || v === 'light' || v === 'auto') return v
  return 'dark'
}

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
  const [mode, setModeState] = useState<ThemeMode>(
    () => defaultMode ?? readStored()
  )
  const [system, setSystem] = useState<'dark' | 'light'>(() => detectSystem())

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const mq = window.matchMedia('(prefers-color-scheme: light)')
    const onChange = () => setSystem(mq.matches ? 'light' : 'dark')
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  const resolved: 'dark' | 'light' = mode === 'auto' ? system : mode

  const useIsoLayoutEffect =
    typeof window === 'undefined' ? useEffect : useLayoutEffect
  useIsoLayoutEffect(() => {
    applyClass(resolved)
  }, [resolved])

  const setMode = useCallback((next: ThemeMode) => {
    setModeState(next)
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(STORAGE_KEY, next)
    }
  }, [])

  const value = useMemo(
    () => ({ mode, resolved, setMode }),
    [mode, resolved, setMode]
  )

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}
