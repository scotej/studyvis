import {
  OnboardingStep,
  type OnboardingStepAction,
  type OnboardingStepProgress,
} from '@/components/OnboardingStep'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'

import { MNEMONIC_WORD_COUNT } from '@/lib/crypto/identity'

export type RecoverErrorKind = 'empty' | 'short' | 'long' | 'invalid'

export type RecoverPhase = 'input' | 'confirm' | 'submitting' | 'done'

export type RecoverViewProps = {
  progress?: OnboardingStepProgress
  phase: RecoverPhase
  value: string
  wordCount: number
  error: RecoverErrorKind | null
  identityExists: boolean
  onChange: (next: string) => void
  onSubmit: () => void
  onBack: () => void
  onConfirmOverwrite: () => void
  onCancelOverwrite: () => void
  onDone: () => void
}

function errorMessage(kind: RecoverErrorKind, wordCount: number): string {
  switch (kind) {
    case 'empty':
      return 'Type your 24-word backup to continue.'
    case 'short':
      return `That's ${wordCount} words. A backup has 24.`
    case 'long':
      return `That's ${wordCount} words. A backup has exactly 24.`
    case 'invalid':
      return "Those 24 words don't add up. Check for a typo or a word out of place against your written copy."
  }
}

// Presentational. The container owns the state machine and passes phase +
// error in; this keeps every state reachable from Storybook without firing
// the Rust keychain commands (the established View + container split).
export function RecoverView({
  progress,
  phase,
  value,
  wordCount,
  error,
  identityExists,
  onChange,
  onSubmit,
  onBack,
  onConfirmOverwrite,
  onCancelOverwrite,
  onDone,
}: RecoverViewProps) {
  if (phase === 'confirm') {
    const primary: OnboardingStepAction = {
      label: 'Replace identity',
      onClick: onConfirmOverwrite,
    }
    const secondary: OnboardingStepAction = {
      label: 'Cancel',
      onClick: onCancelOverwrite,
    }
    return (
      <OnboardingStep
        ariaLabel="Confirm replacing your identity"
        progress={progress}
        primaryAction={primary}
        secondaryAction={secondary}
      >
        <div className="flex w-full max-w-md flex-col items-center gap-3 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">
            Replace the identity on this device?
          </h1>
          <p className="text-sm leading-snug text-text-secondary">
            This writes recovered keys over the ones already here. The current
            identity stays only on whatever device still has it, and this
            can&apos;t be undone.
          </p>
        </div>
      </OnboardingStep>
    )
  }

  if (phase === 'done') {
    return (
      <OnboardingStep
        ariaLabel="Identity restored"
        progress={progress}
        primaryAction={{ label: 'Continue', onClick: onDone }}
      >
        <div className="flex w-full max-w-md flex-col items-center gap-3 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">
            Identity restored.
          </h1>
          <p className="text-sm leading-snug text-text-secondary">
            Your friends list didn&apos;t come with it. They don&apos;t know
            this device is you yet, so you&apos;ll pair with them again.
          </p>
        </div>
      </OnboardingStep>
    )
  }

  const submitting = phase === 'submitting'

  return (
    <OnboardingStep
      ariaLabel="Recover your identity"
      progress={progress}
      primaryAction={{
        label: 'Recover',
        onClick: onSubmit,
        busy: submitting,
      }}
      secondaryAction={{
        label: 'Back',
        onClick: onBack,
        disabled: submitting,
      }}
    >
      <form
        className="flex w-full max-w-md flex-col gap-6"
        onSubmit={(e) => {
          e.preventDefault()
          if (!submitting) onSubmit()
        }}
      >
        <header className="flex flex-col items-center gap-3 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">
            Recover your identity
          </h1>
          <p className="max-w-sm text-sm leading-snug text-text-secondary">
            Type or paste your 24-word backup. The same keys come back on this
            device.
          </p>
        </header>

        <div className="flex flex-col gap-2">
          <Label htmlFor="recover-mnemonic">Recovery phrase</Label>
          <Textarea
            id="recover-mnemonic"
            autoFocus
            rows={4}
            spellCheck={false}
            autoCapitalize="none"
            autoCorrect="off"
            className="font-mono"
            placeholder="ocean ladder cinnamon trumpet …"
            value={value}
            disabled={submitting}
            onChange={(e) => onChange(e.target.value)}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? 'recover-error' : 'recover-count'}
          />
          <div className="flex items-center justify-between gap-3">
            <span id="recover-count" className="text-xs text-text-muted">
              {wordCount} / {MNEMONIC_WORD_COUNT} words
            </span>
            {identityExists ? (
              <span className="text-xs text-text-muted">
                Replaces the identity on this device.
              </span>
            ) : null}
          </div>
          {error ? (
            <p
              id="recover-error"
              role="alert"
              className="text-xs text-status-alerted"
            >
              {errorMessage(error, wordCount)}
            </p>
          ) : null}
        </div>
      </form>
    </OnboardingStep>
  )
}
