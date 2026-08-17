// #225 — the launch-time probe behind the interrupted-session prompt.
//
// Runs once per identity, after `useIdentity` has resolved to a record (so the
// keychain has already answered at least once) and before Home lets the
// dashboard through. Nothing here rejoins anything: the only outcomes are
// "show the prompt" and "carry on".

import { useCallback, useEffect, useRef, useState } from 'react'

import { logger } from '@/lib/log'

import {
  clearSessionRecovery,
  loadSessionRecovery,
  type SessionRecoveryRecord,
} from './recovery'

const log = logger.child('session.recovery')

export type InterruptedSessionState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'prompt'; record: SessionRecoveryRecord; loadedAt: number }
  | { status: 'settled' }

export type InterruptedSession = {
  state: InterruptedSessionState
  // The user chose to rejoin: keep the record, since the session that is
  // starting is the one it describes and will rewrite it anyway.
  dismiss: () => void
  // The user chose to end it: the room credentials stop being ours to hold.
  end: () => void
}

export function useInterruptedSession(
  edPubkeyHex: string | null,
  xPubkeyHex: string | null
): InterruptedSession {
  const [state, setState] = useState<InterruptedSessionState>({
    status: 'idle',
  })
  // Identity we have already probed, so one load runs per identity however
  // many times the effect is invoked.
  const probed = useRef<string | null>(null)

  useEffect(() => {
    if (!edPubkeyHex || !xPubkeyHex) return
    if (probed.current === edPubkeyHex) return
    probed.current = edPubkeyHex
    setState({ status: 'loading' })
    // Deliberately no cleanup flag. StrictMode runs this effect twice, and the
    // ref above makes the second run a no-op — so a cleanup that cancelled the
    // first run's result would leave this stuck on 'loading' forever, with the
    // blank boot screen Home shows while it waits. A late setState after
    // unmount is a no-op; a load that never resolves anything is a white
    // screen. `probed` doubles as the staleness check if the identity changes.
    void (async () => {
      const loadedAt = Date.now()
      try {
        const result = await loadSessionRecovery(
          { edPubkeyHex, xPubkeyHex },
          loadedAt
        )
        if (probed.current !== edPubkeyHex) return
        if (result.kind === 'record') {
          setState({ status: 'prompt', record: result.record, loadedAt })
          return
        }
        // 'unavailable' left the sealed record on disk on purpose. Boot into
        // the dashboard rather than blocking on something the next launch may
        // read fine, and say so in diagnostics.
        if (result.kind === 'unavailable') {
          log.warn('recovery.unreadable_this_boot')
        }
        setState({ status: 'settled' })
      } catch (err) {
        // Whatever happened, the app must reach its dashboard.
        log.error('recovery.probe_failed', { err })
        if (probed.current === edPubkeyHex) setState({ status: 'settled' })
      }
    })()
  }, [edPubkeyHex, xPubkeyHex])

  const dismiss = useCallback(() => {
    setState({ status: 'settled' })
  }, [])

  const end = useCallback(() => {
    setState({ status: 'settled' })
    void clearSessionRecovery()
  }, [])

  return { state, dismiss, end }
}
