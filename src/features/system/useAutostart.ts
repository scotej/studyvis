import { useCallback, useEffect, useState } from 'react'

import { getAutostartEnabled, setAutostartEnabled } from './autostart'

export type AutostartStatus = 'loading' | 'ready' | 'error' | 'unavailable'

export type UseAutostartResult = {
  enabled: boolean
  status: AutostartStatus
  error: string | null
  toggle: (next: boolean) => Promise<void>
}

export function useAutostart(): UseAutostartResult {
  const [enabled, setEnabled] = useState(false)
  const [status, setStatus] = useState<AutostartStatus>('loading')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
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
        setStatus('unavailable')
      })
    return () => {
      cancelled = true
    }
  }, [])

  const toggle = useCallback(async (next: boolean) => {
    try {
      await setAutostartEnabled(next)
      setEnabled(next)
      setStatus('ready')
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setStatus('error')
    }
  }, [])

  return { enabled, status, error, toggle }
}
