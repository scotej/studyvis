import { useState } from 'react'
import { toast } from 'sonner'

import { BipBackupPanel } from '@/components/BipBackupPanel'
import {
  OnboardingStep,
  type OnboardingStepProgress,
} from '@/components/OnboardingStep'
import { strings } from '@/strings'

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
      toast.error(strings.common.errors.savingIdentity)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <OnboardingStep
      ariaLabel={strings.identity.setup.ariaLabel}
      progress={progress}
      primaryAction={{
        label: strings.common.actions.continue,
        onClick: () => void handleContinue(),
        disabled: !acknowledged,
        busy: submitting,
        ariaDescribedby: 'identity-ack-text',
      }}
    >
      <header className="flex flex-col items-center gap-3 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">
          {strings.identity.setup.heading}
        </h1>
        <p className="max-w-md text-sm leading-snug text-text-secondary">
          {strings.identity.setup.body}
        </p>
      </header>

      <BipBackupPanel
        mnemonic={mnemonic}
        confirm={{ checked: acknowledged, onCheckedChange: setAcknowledged }}
      />
    </OnboardingStep>
  )
}
