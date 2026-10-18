import { useLayoutEffect, useRef, useState } from 'react'

import { type OnboardingStepProgress } from '@/components/OnboardingStep'

import { IdentitySetup } from './IdentitySetup'
import type { CreatedIdentity } from './useIdentity'

export type IdentitySetupGateProps = {
  create: () => CreatedIdentity
  progress?: OnboardingStepProgress
  onBack?: () => void
  onConfirmed?: () => void | Promise<void>
}

// `useState` with a lazy initializer guarantees `create()` runs exactly once
// per mount, so the words shown to the user always match the keys committed.
// (StrictMode dev still double-mounts; each mount is internally consistent.)
export function IdentitySetupGate({
  create,
  progress,
  onBack,
  onConfirmed,
}: IdentitySetupGateProps) {
  const [created] = useState<CreatedIdentity>(create)
  const lifetime = useRef({ active: true })
  useLayoutEffect(() => {
    const operation = { active: true }
    lifetime.current = operation
    return () => {
      operation.active = false
    }
  }, [])
  return (
    <IdentitySetup
      mnemonic={created.mnemonic}
      progress={progress}
      onBack={onBack}
      onConfirm={async () => {
        const operation = lifetime.current
        await created.commit()
        if (operation.active && onConfirmed) await onConfirmed()
      }}
    />
  )
}
