import { CheckIcon, UserPlus2Icon } from 'lucide-react'

import {
  OnboardingStep,
  type OnboardingStepProgress,
} from '@/components/OnboardingStep'
import { Button } from '@/components/ui/button'

export type AddFriendStepViewProps = {
  progress?: OnboardingStepProgress
  justAdded: boolean
  onAdd: () => void
  onContinue: () => void
}

// Presentational shell for the "add first friend" step. The container in
// `AddFriendStep.tsx` snapshots the friends-store baseline + drives the real
// AddFriendDialog; this component is the pure rendering surface that
// Storybook can consume without the store or pairing infrastructure.
export function AddFriendStepView({
  progress,
  justAdded,
  onAdd,
  onContinue,
}: AddFriendStepViewProps) {
  return (
    <OnboardingStep
      ariaLabel="Add your first friend"
      progress={progress}
      primaryAction={{
        label: justAdded ? 'Continue' : 'Skip for now',
        onClick: onContinue,
      }}
    >
      <div className="flex w-full max-w-md flex-col items-center gap-6 text-center">
        {justAdded ? (
          <div
            role="status"
            className="flex w-full flex-col items-center gap-3 rounded-lg border border-status-focused/40 bg-status-focused/10 px-6 py-8"
          >
            <CheckIcon className="size-6 text-status-focused" aria-hidden />
            <p className="text-base font-medium text-text-primary">
              Paired. Now invite them to a session.
            </p>
            <p className="text-sm text-text-secondary">
              They&apos;ll be in your friends list when you&apos;re done.
            </p>
          </div>
        ) : (
          <>
            <header className="flex flex-col items-center gap-3">
              <UserPlus2Icon
                className="size-8 text-text-secondary"
                aria-hidden
              />
              <h1 className="text-2xl font-semibold tracking-tight">
                Add your first friend
              </h1>
              <p className="max-w-sm text-sm leading-snug text-text-secondary">
                You and a friend each generate a one-time code; pasting it on
                the other side pairs you. After that, sessions are one click.
              </p>
            </header>
            <Button onClick={onAdd}>
              <UserPlus2Icon /> Add a friend
            </Button>
          </>
        )}
      </div>
    </OnboardingStep>
  )
}
