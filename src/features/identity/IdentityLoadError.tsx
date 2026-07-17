import { useState } from 'react'

import { useIdentity } from './useIdentity'
import { IdentityLoadErrorView } from './IdentityLoadErrorView'
import { Recover } from './Recover'

type Mode = 'error' | 'recover'

// D1 container. Shown by Home when identity status is 'error' (identity.json
// exists but couldn't be read). Retry re-runs the load; Recover mounts the
// existing 24-word flow — which, because identity_exists() is true, goes
// through its own overwrite confirm before committing.
//
// #47 E1 — the 'keys-missing' errorKind (file parsed fine but the keychain
// definitively holds no keys) renders the same screen with recovery-first
// copy: retrying can't fix an empty keychain, so the 24-word restore is the
// primary action there.
export function IdentityLoadError() {
  const { errorKind, staleRecord, actions } = useIdentity()
  const [mode, setMode] = useState<Mode>('error')
  const [retrying, setRetrying] = useState(false)

  if (mode === 'recover') {
    return (
      <Recover
        identityExists
        // On keys-missing the record parsed fine: its fingerprint lets the
        // D5 same-words fast path fire, so typing your OWN 24 words commits
        // without the "replace identity?" scare (as keysMissing.recoverNote
        // promises), while different words still get the escalated warning.
        // The 'file' variant has no readable record — this stays null and
        // the flow falls back to the generic confirm, as before.
        currentFingerprint={staleRecord?.mnemonic_fingerprint ?? null}
        recover={actions.recover}
        onBack={() => setMode('error')}
        // After a successful recovery the store status is already 'ready'; a
        // refresh re-reads the freshly written record so Home leaves this gate.
        onRecovered={() => void actions.refresh()}
      />
    )
  }

  return (
    <IdentityLoadErrorView
      variant={errorKind === 'keys-missing' ? 'keysMissing' : 'file'}
      retrying={retrying}
      onRetry={() => {
        setRetrying(true)
        void actions.refresh().finally(() => setRetrying(false))
      }}
      onRecover={() => setMode('recover')}
    />
  )
}
