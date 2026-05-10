import { DoorOpenIcon, MicIcon, UserPlus2Icon } from 'lucide-react'

import {
  OnboardingStep,
  type OnboardingStepProgress,
} from '@/components/OnboardingStep'
import { Kbd } from '@/components/ui/kbd'
import { isMacLikePlatform } from '@/lib/utils'

export type TutorialStepProps = {
  progress?: OnboardingStepProgress
  onContinue: () => void
}

export function TutorialStep({ progress, onContinue }: TutorialStepProps) {
  const pttKey = isMacLikePlatform() ? '⌘[' : 'Ctrl+['

  return (
    <OnboardingStep
      ariaLabel="How a session works"
      progress={progress}
      primaryAction={{ label: 'Get started', onClick: onContinue }}
    >
      <header className="flex flex-col items-center gap-3 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">
          How a session works
        </h1>
        <p className="max-w-md text-sm leading-snug text-text-secondary">
          Three things to know. You can re-read this any time from Settings.
        </p>
      </header>

      <ol
        className="grid w-full grid-cols-1 gap-4 md:grid-cols-3"
        aria-label="Three tips"
      >
        <TutorialCard
          Icon={UserPlus2Icon}
          title="Invite a friend"
          body="Click a friend in your list. Their app will ring; if they take the call, you're in a session together."
        />
        <TutorialCard
          Icon={MicIcon}
          title="Talk when you mean to"
          body={
            <>
              You're muted by default. Hold <Kbd>{pttKey}</Kbd> to talk; let go
              to mute.
            </>
          }
        />
        <TutorialCard
          Icon={DoorOpenIcon}
          title="Leave any time"
          body="Click Leave to drop out. The session ends for everyone when only one of you is left."
        />
      </ol>
    </OnboardingStep>
  )
}

function TutorialCard({
  Icon,
  title,
  body,
}: {
  Icon: typeof UserPlus2Icon
  title: string
  body: React.ReactNode
}) {
  return (
    <li className="flex flex-col gap-3 rounded-lg border border-border-default bg-bg-surface p-5">
      <div className="flex size-9 items-center justify-center rounded-md bg-bg-raised text-text-secondary">
        <Icon className="size-5" aria-hidden />
      </div>
      <div className="flex flex-col gap-1">
        <h3 className="text-base font-medium text-text-primary">{title}</h3>
        <p className="text-sm leading-snug text-text-secondary">{body}</p>
      </div>
    </li>
  )
}
