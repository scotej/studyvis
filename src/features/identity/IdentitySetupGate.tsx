import { useState } from 'react'

import { type OnboardingStepProgress } from '@/components/OnboardingStep'

import { IdentitySetup } from './IdentitySetup'
import type { CreatedIdentity } from './useIdentity'

export type IdentitySetupGateProps = {
  create: () => CreatedIdentity
  progress?: OnboardingStepProgress
  onConfirmed?: () => void | Promise<void>
}

// `useState` with a lazy initializer guarantees `create()` runs exactly once
// per mount, so the words shown to the user always match the keys committed.
// (StrictMode dev still double-mounts; each mount is internally consistent.)
export function IdentitySetupGate({
  create,
  progress,
  onConfirmed,
}: IdentitySetupGateProps) {
  const [created] = useState<CreatedIdentity>(create)
  return (
    <IdentitySetup
      mnemonic={created.mnemonic}
      progress={progress}
      onConfirm={async () => {
        await created.commit()
        if (onConfirmed) await onConfirmed()
      }}
    />
  )
}
