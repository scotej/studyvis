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
  onBack?: () => void
  progress?: OnboardingStepProgress
}

// Stable substring of the Rust identity_save_keys "keys already exist" error
// (see KEYS_EXIST_MARKER in src-tauri/src/commands/identity.rs). The create
// path refuses to clobber an existing keychain entry; when that fires (e.g.
// identity.json was lost but the keychain survived), steer the user to Back →
// "I have a backup" instead of dead-ending on the generic save error.
const KEYS_EXIST_MARKER = 'identity keys already exist'

export function IdentitySetup({
  mnemonic,
  onConfirm,
  onBack,
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
      const raw = err instanceof Error ? err.message : String(err)
      toast.error(
        raw.includes(KEYS_EXIST_MARKER)
          ? strings.identity.setup.keysExistError
          : strings.common.errors.savingIdentity
      )
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <OnboardingStep
      ariaLabel={strings.identity.setup.ariaLabel}
      progress={progress}
      secondaryAction={
        onBack
          ? { label: strings.common.actions.back, onClick: onBack }
          : undefined
      }
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
