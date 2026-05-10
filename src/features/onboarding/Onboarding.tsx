import { useCallback, useState } from 'react'

import { IdentitySetupGate, useIdentity } from '@/features/identity'

import { AddFriendStep } from './AddFriendStep'
import { DisplayNameStep } from './DisplayNameStep'
import { PermissionsStep } from './PermissionsStep'
import { TutorialStep } from './TutorialStep'
import { WelcomeStep } from './WelcomeStep'

export type OnboardingProps = {
  onComplete: () => void | Promise<void>
}

const STEPS = [
  'welcome',
  'permissions',
  'identity',
  'name',
  'friend',
  'tutorial',
] as const
type StepId = (typeof STEPS)[number]
const TOTAL_STEPS = STEPS.length

// Top-level orchestrator for the V1 onboarding flow (PLAN.md §5):
//   welcome → permissions → identity → display name → add friend → tutorial.
// Skips the identity step if the user already has keys, and the name step
// if `display_name` is already set, so legacy installs that pre-date this
// phase aren't forced through redundant prompts.
export function Onboarding({ onComplete }: OnboardingProps) {
  const { identity, status, actions } = useIdentity()

  const [stepIndex, setStepIndex] = useState(0)
  const [nameSubmitting, setNameSubmitting] = useState(false)
  const [nameError, setNameError] = useState<string | null>(null)

  const advance = useCallback(() => {
    setStepIndex((cur) => {
      let next = cur + 1
      while (next < STEPS.length) {
        const id = STEPS[next]
        if (id === 'identity' && status === 'ready') {
          next += 1
          continue
        }
        if (id === 'name' && identity?.display_name) {
          next += 1
          continue
        }
        break
      }
      return Math.min(next, STEPS.length - 1)
    })
  }, [identity?.display_name, status])

  const finish = useCallback(() => {
    void onComplete()
  }, [onComplete])

  const handleSetDisplayName = useCallback(
    async (name: string) => {
      setNameSubmitting(true)
      setNameError(null)
      try {
        await actions.setDisplayName(name)
        advance()
      } catch (err) {
        setNameError(
          err instanceof Error ? err.message : 'Could not save name.'
        )
      } finally {
        setNameSubmitting(false)
      }
    },
    [actions, advance]
  )

  const id: StepId = STEPS[stepIndex]
  const progress = { current: stepIndex + 1, total: TOTAL_STEPS }

  if (status === 'loading') {
    return (
      <main
        className="flex min-h-screen items-center justify-center bg-bg-base text-text-secondary"
        aria-busy="true"
      />
    )
  }

  if (id === 'welcome') {
    return <WelcomeStep progress={progress} onContinue={advance} />
  }
  if (id === 'permissions') {
    return <PermissionsStep progress={progress} onContinue={advance} />
  }
  if (id === 'identity') {
    return (
      <IdentitySetupGate
        progress={progress}
        create={actions.create}
        onConfirmed={advance}
      />
    )
  }
  if (id === 'name') {
    return (
      <DisplayNameStep
        progress={progress}
        initialValue={identity?.display_name ?? ''}
        submitting={nameSubmitting}
        error={nameError}
        onSubmit={(name) => void handleSetDisplayName(name)}
      />
    )
  }
  if (id === 'friend') {
    return <AddFriendStep progress={progress} onContinue={advance} />
  }
  return <TutorialStep progress={progress} onContinue={finish} />
}
