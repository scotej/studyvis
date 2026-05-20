import {
  OnboardingStep,
  type OnboardingStepProgress,
} from '@/components/OnboardingStep'
import { Logo } from '@/components/Logo'
import { strings } from '@/strings'

export type WelcomeStepProps = {
  progress?: OnboardingStepProgress
  onContinue: () => void
}

export function WelcomeStep({ progress, onContinue }: WelcomeStepProps) {
  return (
    <OnboardingStep
      ariaLabel={strings.onboarding.welcome.ariaLabel}
      progress={progress}
      primaryAction={{
        label: strings.onboarding.welcome.cta,
        onClick: onContinue,
      }}
    >
      <div className="flex flex-col items-center gap-6 text-center">
        <Logo size="xl" />
        <h1 className="text-2xl font-semibold tracking-tight">
          {strings.onboarding.welcome.heading}
        </h1>
        <p className="max-w-md text-sm leading-snug text-text-secondary">
          {strings.onboarding.welcome.body}
        </p>
      </div>
    </OnboardingStep>
  )
}
