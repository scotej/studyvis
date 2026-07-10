// Hook wrapping the OS launch-at-login toggle. The OS registry is the source
// of truth (state is re-read after every write); a request-id guard makes
// rapid toggles last-write-wins instead of interleaving. Reports
// 'unavailable' outside the Tauri runtime so Storybook renders a disabled row.

import { useCallback, useEffect, useRef, useState } from 'react'

import { getAutostartEnabled, setAutostartEnabled } from './autostart'

export type AutostartStatus =
  | 'loading'
  | 'ready'
  | 'saving'
  | 'error'
  | 'unavailable'

export type UseAutostartResult = {
  enabled: boolean
  status: AutostartStatus
  error: string | null
  toggle: (next: boolean) => Promise<void>
}

function isTauriRuntime(): boolean {
  return (
    typeof window !== 'undefined' &&
    ('__TAURI_INTERNALS__' in window || '__TAURI__' in window)
  )
}

export function useAutostart(): UseAutostartResult {
  const [enabled, setEnabled] = useState(false)
  const [status, setStatus] = useState<AutostartStatus>(() =>
    isTauriRuntime() ? 'loading' : 'unavailable'
  )
  const [error, setError] = useState<string | null>(null)
  // Last-write-wins: each toggle bumps the counter; only the most recent
  // request is allowed to publish state, so a quick double-flip can't end up
  // in the wrong terminal value due to out-of-order resolution.
  const requestIdRef = useRef(0)

  useEffect(() => {
    if (!isTauriRuntime()) return
    let cancelled = false
    void getAutostartEnabled()
      .then((value) => {
        if (cancelled) return
        setEnabled(value)
        setStatus('ready')
      })
      .catch((err) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
        setStatus('error')
      })
    return () => {
      cancelled = true
    }
  }, [])

  const toggle = useCallback(async (next: boolean) => {
    if (!isTauriRuntime()) {
      setStatus('unavailable')
      return
    }
    const id = ++requestIdRef.current
    setStatus('saving')
    try {
      await setAutostartEnabled(next)
      if (id !== requestIdRef.current) return
      setEnabled(next)
      setStatus('ready')
      setError(null)
    } catch (err) {
      if (id !== requestIdRef.current) return
      setError(err instanceof Error ? err.message : String(err))
      setStatus('error')
    }
  }, [])

  return { enabled, status, error, toggle }
}
