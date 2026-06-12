import { useState } from 'react'

import { type OnboardingStepProgress } from '@/components/OnboardingStep'
import { IdentitySetupGate, Recover, useIdentity } from '@/features/identity'

import { IdentityChoiceStep } from './IdentityChoiceStep'

export type IdentityStepProps = {
  progress?: OnboardingStepProgress
  onComplete: () => void
  // Back to the previous onboarding step. Only wired into the choice fork;
  // the create/recover sub-screens own their own back-to-choice.
  onBack?: () => void
}

type Mode = 'choice' | 'create' | 'recover'

// Onboarding's identity step. The fork shows first; a mnemonic is only
// generated once the user picks "create" (IdentitySetupGate mounts then).
// Recovery and creation both commit through the one identityStore path.
export function IdentityStep({
  progress,
  onComplete,
  onBack,
}: IdentityStepProps) {
  const { identity, actions, status } = useIdentity()
  const [mode, setMode] = useState<Mode>('choice')

  if (mode === 'create') {
    return (
      <IdentitySetupGate
        progress={progress}
        create={actions.create}
        onBack={() => setMode('choice')}
        onConfirmed={onComplete}
      />
    )
  }

  if (mode === 'recover') {
    return (
      <Recover
        progress={progress}
        identityExists={status === 'ready'}
        currentFingerprint={identity?.mnemonic_fingerprint}
        recover={actions.recover}
        onBack={() => setMode('choice')}
        onRecovered={onComplete}
      />
    )
  }

  return (
    <IdentityChoiceStep
      progress={progress}
      onCreate={() => setMode('create')}
      onRecover={() => setMode('recover')}
      onBack={onBack}
    />
  )
}
