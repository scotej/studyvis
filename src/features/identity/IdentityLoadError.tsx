import { useState } from 'react'

import { useIdentity } from './useIdentity'
import { IdentityLoadErrorView } from './IdentityLoadErrorView'
import { Recover } from './Recover'

type Mode = 'error' | 'recover'

// D1 container. Shown by Home when identity status is 'error' (identity.json
// exists but couldn't be read). Retry re-runs the load; Recover mounts the
// existing 24-word flow — which, because identity_exists() is true, goes
// through its own overwrite confirm before committing.
export function IdentityLoadError() {
  const { actions } = useIdentity()
  const [mode, setMode] = useState<Mode>('error')
  const [retrying, setRetrying] = useState(false)

  if (mode === 'recover') {
    return (
      <Recover
        identityExists
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
      retrying={retrying}
      onRetry={() => {
        setRetrying(true)
        void actions.refresh().finally(() => setRetrying(false))
      }}
      onRecover={() => setMode('recover')}
    />
  )
}
