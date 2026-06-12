import {
  OnboardingStep,
  type OnboardingStepProgress,
} from '@/components/OnboardingStep'
import { Button } from '@/components/ui/button'
import { strings } from '@/strings'

export type IdentityChoiceStepProps = {
  progress?: OnboardingStepProgress
  onCreate: () => void
  onRecover: () => void
  onBack?: () => void
}

// The fork that must precede key generation: a fresh identity, or restoring
// one from a 24-word backup. Presentational; the container decides what each
// choice mounts (and only then is a mnemonic generated).
export function IdentityChoiceStep({
  progress,
  onCreate,
  onRecover,
  onBack,
}: IdentityChoiceStepProps) {
  return (
    <OnboardingStep
      ariaLabel={strings.onboarding.identityChoice.ariaLabel}
      progress={progress}
      secondaryAction={
        onBack
          ? { label: strings.common.actions.back, onClick: onBack }
          : undefined
      }
    >
      <header className="flex flex-col items-center gap-3 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">
          {strings.onboarding.identityChoice.heading}
        </h1>
        <p className="max-w-md text-sm leading-snug text-text-secondary">
          {strings.onboarding.identityChoice.body}
        </p>
      </header>

      <div className="flex w-full max-w-xs flex-col gap-3">
        <Button size="lg" autoFocus onClick={onCreate}>
          {strings.onboarding.identityChoice.createCta}
        </Button>
        <Button size="lg" variant="outline" onClick={onRecover}>
          {strings.onboarding.identityChoice.recoverCta}
        </Button>
      </div>
    </OnboardingStep>
  )
}
