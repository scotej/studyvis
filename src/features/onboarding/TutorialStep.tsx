import { DoorOpenIcon, MicIcon, UserPlus2Icon } from 'lucide-react'

import {
  OnboardingStep,
  type OnboardingStepProgress,
} from '@/components/OnboardingStep'
import { Kbd } from '@/components/ui/kbd'
import { isMacLikePlatform } from '@/lib/utils'
import { strings } from '@/strings'

export type TutorialStepProps = {
  progress?: OnboardingStepProgress
  onContinue: () => void
}

export function TutorialStep({ progress, onContinue }: TutorialStepProps) {
  const pttKey = isMacLikePlatform() ? '⌘[' : 'Ctrl+['
  const cards = strings.onboarding.tutorial.cards

  return (
    <OnboardingStep
      ariaLabel={strings.onboarding.tutorial.ariaLabel}
      progress={progress}
      primaryAction={{
        label: strings.onboarding.tutorial.cta,
        onClick: onContinue,
      }}
    >
      <header className="flex flex-col items-center gap-3 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">
          {strings.onboarding.tutorial.heading}
        </h1>
        <p className="max-w-md text-sm leading-snug text-text-secondary">
          {strings.onboarding.tutorial.body}
        </p>
      </header>

      <ol
        className="grid w-full grid-cols-1 gap-4 md:grid-cols-3"
        aria-label={strings.onboarding.tutorial.listAriaLabel}
      >
        <TutorialCard
          Icon={UserPlus2Icon}
          title={cards.invite.title}
          body={cards.invite.body}
        />
        <TutorialCard
          Icon={MicIcon}
          title={cards.talk.title}
          body={
            <>
              {cards.talk.bodyBeforeKbd}
              <Kbd>{pttKey}</Kbd>
              {cards.talk.bodyAfterKbd}
            </>
          }
        />
        <TutorialCard
          Icon={DoorOpenIcon}
          title={cards.leave.title}
          body={cards.leave.body}
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
