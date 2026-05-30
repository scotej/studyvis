import { CheckIcon, UserPlus2Icon } from 'lucide-react'

import {
  OnboardingStep,
  type OnboardingStepProgress,
} from '@/components/OnboardingStep'
import { Button } from '@/components/ui/button'
import { strings } from '@/strings'

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
      ariaLabel={strings.onboarding.addFriend.ariaLabel}
      progress={progress}
      // Label is intentionally state-aware; the handler is uniform because both
      // states semantically mean "advance onboarding." Pre-pair, the user is
      // skipping; post-pair, the user is continuing — same exit, honest copy.
      primaryAction={{
        label: justAdded
          ? strings.common.actions.continue
          : strings.common.actions.skipForNow,
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
              {strings.onboarding.addFriend.paired}
            </p>
            <p className="text-sm text-text-secondary">
              {strings.onboarding.addFriend.pairedDetail}
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
                {strings.onboarding.addFriend.heading}
              </h1>
              <p className="max-w-sm text-sm leading-snug text-text-secondary">
                {strings.onboarding.addFriend.body}
              </p>
            </header>
            <Button onClick={onAdd}>
              {strings.onboarding.addFriend.addCta}
            </Button>
          </>
        )}
      </div>
    </OnboardingStep>
  )
}
