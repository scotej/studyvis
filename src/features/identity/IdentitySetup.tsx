import { useState } from 'react'
import { toast } from 'sonner'

import { BipBackupPanel } from '@/components/BipBackupPanel'
import {
  OnboardingStep,
  type OnboardingStepProgress,
} from '@/components/OnboardingStep'

import type { Mnemonic } from '@/lib/crypto/identity'

export type IdentitySetupProps = {
  mnemonic: Mnemonic
  onConfirm: () => void | Promise<void>
  progress?: OnboardingStepProgress
}

export function IdentitySetup({
  mnemonic,
  onConfirm,
  progress,
}: IdentitySetupProps) {
  const [acknowledged, setAcknowledged] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  async function handleContinue() {
    if (!acknowledged || submitting) return
    setSubmitting(true)
    try {
      await onConfirm()
    } catch (err) {
      console.error(err)
      toast.error("Couldn't save your identity.")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <OnboardingStep
      ariaLabel="Save your recovery phrase"
      progress={progress}
      primaryAction={{
        label: 'Continue',
        onClick: () => void handleContinue(),
        disabled: !acknowledged,
        busy: submitting,
        ariaDescribedby: 'identity-ack-text',
      }}
    >
      <header className="flex flex-col items-center gap-3 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">
          Save these 24 words somewhere safe
        </h1>
        <p className="max-w-md text-sm leading-snug text-text-secondary">
          If you lose this laptop, these words are the only way to recover this
          identity. Pen and paper. No cloud sync.
        </p>
      </header>

      <BipBackupPanel
        mnemonic={mnemonic}
        confirm={{ checked: acknowledged, onCheckedChange: setAcknowledged }}
      />
    </OnboardingStep>
  )
}
