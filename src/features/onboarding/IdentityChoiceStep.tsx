import {
  OnboardingStep,
  type OnboardingStepProgress,
} from '@/components/OnboardingStep'
import { Button } from '@/components/ui/button'

export type IdentityChoiceStepProps = {
  progress?: OnboardingStepProgress
  onCreate: () => void
  onRecover: () => void
}

// The fork that must precede key generation: a fresh identity, or restoring
// one from a 24-word backup. Presentational; the container decides what each
// choice mounts (and only then is a mnemonic generated).
export function IdentityChoiceStep({
  progress,
  onCreate,
  onRecover,
}: IdentityChoiceStepProps) {
  return (
    <OnboardingStep ariaLabel="Set up your identity" progress={progress}>
      <header className="flex flex-col items-center gap-3 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">
          Set up your identity
        </h1>
        <p className="max-w-md text-sm leading-snug text-text-secondary">
          New to StudyVis, or moving to a new device? Either way, no account and
          no server.
        </p>
      </header>

      <div className="flex w-full max-w-xs flex-col gap-3">
        <Button size="lg" onClick={onCreate}>
          Create a new identity
        </Button>
        <Button size="lg" variant="outline" onClick={onRecover}>
          I have a 24-word backup
        </Button>
      </div>
    </OnboardingStep>
  )
}
