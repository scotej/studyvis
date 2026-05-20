import {
  OnboardingStep,
  type OnboardingStepAction,
  type OnboardingStepProgress,
} from '@/components/OnboardingStep'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { strings } from '@/strings'

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
  const errs = strings.identity.recover.errors
  switch (kind) {
    case 'empty':
      return errs.empty
    case 'short':
      return errs.short(wordCount)
    case 'long':
      return errs.long(wordCount)
    case 'invalid':
      return errs.invalid
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
      label: strings.identity.recover.confirm.cta,
      onClick: onConfirmOverwrite,
    }
    const secondary: OnboardingStepAction = {
      label: strings.common.actions.cancel,
      onClick: onCancelOverwrite,
    }
    return (
      <OnboardingStep
        ariaLabel={strings.identity.recover.confirm.ariaLabel}
        progress={progress}
        primaryAction={primary}
        secondaryAction={secondary}
      >
        <div className="flex w-full max-w-md flex-col items-center gap-3 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">
            {strings.identity.recover.confirm.heading}
          </h1>
          <p className="text-sm leading-snug text-text-secondary">
            {strings.identity.recover.confirm.body}
          </p>
        </div>
      </OnboardingStep>
    )
  }

  if (phase === 'done') {
    return (
      <OnboardingStep
        ariaLabel={strings.identity.recover.done.ariaLabel}
        progress={progress}
        primaryAction={{
          label: strings.identity.recover.done.cta,
          onClick: onDone,
        }}
      >
        <div className="flex w-full max-w-md flex-col items-center gap-3 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">
            {strings.identity.recover.done.heading}
          </h1>
          <p className="text-sm leading-snug text-text-secondary">
            {strings.identity.recover.done.body}
          </p>
        </div>
      </OnboardingStep>
    )
  }

  const submitting = phase === 'submitting'

  return (
    <OnboardingStep
      ariaLabel={strings.identity.recover.input.ariaLabel}
      progress={progress}
      primaryAction={{
        label: strings.identity.recover.input.cta,
        onClick: onSubmit,
        busy: submitting,
      }}
      secondaryAction={{
        label: strings.common.actions.back,
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
            {strings.identity.recover.input.heading}
          </h1>
          <p className="max-w-sm text-sm leading-snug text-text-secondary">
            {strings.identity.recover.input.body}
          </p>
        </header>

        <div className="flex flex-col gap-2">
          <Label htmlFor="recover-mnemonic">
            {strings.identity.recover.input.label}
          </Label>
          <Textarea
            id="recover-mnemonic"
            autoFocus
            rows={4}
            spellCheck={false}
            autoCapitalize="none"
            autoCorrect="off"
            className="font-mono"
            placeholder={strings.identity.recover.input.placeholder}
            value={value}
            disabled={submitting}
            onChange={(e) => onChange(e.target.value)}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? 'recover-error' : 'recover-count'}
          />
          <div className="flex items-center justify-between gap-3">
            <span id="recover-count" className="text-xs text-text-muted">
              {strings.identity.recover.input.countLabel(
                wordCount,
                MNEMONIC_WORD_COUNT
              )}
            </span>
            {identityExists ? (
              <span className="text-xs text-text-muted">
                {strings.identity.recover.input.replaceNote}
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
