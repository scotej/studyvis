import { useState } from 'react'

import { IdentitySetup } from './IdentitySetup'
import type { CreatedIdentity } from './useIdentity'

export type IdentitySetupGateProps = {
  create: () => CreatedIdentity
}

// `useState` with a lazy initializer guarantees `create()` runs exactly once
// per mount, so the words shown to the user always match the keys committed.
// (StrictMode dev still double-mounts; each mount is internally consistent.)
export function IdentitySetupGate({ create }: IdentitySetupGateProps) {
  const [created] = useState<CreatedIdentity>(create)
  return (
    <IdentitySetup mnemonic={created.mnemonic} onConfirm={created.commit} />
  )
}
