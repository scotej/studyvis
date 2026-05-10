import {
  OnboardingStep,
  type OnboardingStepProgress,
} from '@/components/OnboardingStep'
import { Logo } from '@/components/Logo'

export type WelcomeStepProps = {
  progress?: OnboardingStepProgress
  onContinue: () => void
}

export function WelcomeStep({ progress, onContinue }: WelcomeStepProps) {
  return (
    <OnboardingStep
      ariaLabel="Welcome"
      progress={progress}
      primaryAction={{ label: "Let's set up", onClick: onContinue }}
    >
      <div className="flex flex-col items-center gap-6 text-center">
        <Logo size="xl" />
        <h1 className="text-2xl font-semibold tracking-tight">
          Let&apos;s set you up.
        </h1>
        <p className="max-w-md text-sm leading-snug text-text-secondary">
          StudyVis is a quiet place to study with friends. No account, no
          server, no audience. Just you, your friends, and the work.
        </p>
      </div>
    </OnboardingStep>
  )
}
