import { useCallback, useEffect, useState } from 'react'

import { Skeleton } from '@/components/ui/skeleton'
import { useIdentity } from '@/features/identity'
import { strings } from '@/strings'

import { AddFriendStep } from './AddFriendStep'
import { DisplayNameStep } from './DisplayNameStep'
import { IdentityStep } from './IdentityStep'
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

  // Freeze identity/name visibility at the first resolved (non-loading) render.
  // These steps are skipped only for users who already had keys / a name when
  // onboarding began; recomputing live would shrink the progress-dot count as a
  // new user creates them mid-flow (status flips to "ready").
  const [frozenSkips, setFrozenSkips] = useState<{
    identity: boolean
    name: boolean
  } | null>(null)

  useEffect(() => {
    if (frozenSkips !== null || status === 'loading') return
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot snapshot of the optional steps a returning user skips, latched once identity status resolves; idempotent
    setFrozenSkips({
      identity: status === 'ready',
      name: Boolean(identity?.display_name),
    })
  }, [frozenSkips, status, identity?.display_name])

  const skips = frozenSkips ?? {
    identity: status === 'ready',
    name: Boolean(identity?.display_name),
  }

  const isStepVisible = useCallback(
    (id: StepId) => {
      if (id === 'identity' && skips.identity) return false
      if (id === 'name' && skips.name) return false
      return true
    },
    [skips.identity, skips.name]
  )

  const advance = useCallback(() => {
    setStepIndex((cur) => {
      let next = cur + 1
      while (next < STEPS.length && !isStepVisible(STEPS[next])) {
        next += 1
      }
      return Math.min(next, STEPS.length - 1)
    })
  }, [isStepVisible])

  // U3 — Back navigation (DESIGN-SYSTEM §8.1's [Back] [Continue] wireframe).
  // Steps the wrong way to a *previous* visible step; the welcome step (first
  // visible) has no Back. Identity creation is the point of no return: once
  // the create path commits a mnemonic, status flips to 'ready' while the
  // identity step was part of this flow (it wasn't skipped at start), so Back
  // is suppressed — returning to the identity step would mint a *new* mnemonic
  // and silently abandon the just-created keypair. Recovery commits the same
  // way, so the same suppression protects a freshly recovered identity.
  const back = useCallback(() => {
    setStepIndex((cur) => {
      let prev = cur - 1
      while (prev > 0 && !isStepVisible(STEPS[prev])) {
        prev -= 1
      }
      return Math.max(prev, 0)
    })
  }, [isStepVisible])

  const mnemonicCommitted = status === 'ready' && !skips.identity
  const firstVisibleIndex = STEPS.findIndex(isStepVisible)
  const canGoBack = stepIndex > firstVisibleIndex && !mnemonicCommitted
  const onBack = canGoBack ? back : undefined

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
          err instanceof Error
            ? err.message
            : strings.onboarding.displayName.saveErrorFallback
        )
      } finally {
        setNameSubmitting(false)
      }
    },
    [actions, advance]
  )

  const id: StepId = STEPS[stepIndex]
  const visibleSteps = STEPS.filter(isStepVisible)
  const reached = STEPS.slice(0, stepIndex + 1).filter(isStepVisible).length
  const progress = {
    current: Math.min(visibleSteps.length, Math.max(1, reached)),
    total: visibleSteps.length,
  }

  if (status === 'loading') {
    return (
      <main
        className="flex min-h-full items-center justify-center bg-bg-base text-text-secondary"
        aria-busy="true"
      >
        <span className="sr-only">{strings.common.loading}</span>
        <div
          aria-hidden
          className="flex w-full max-w-md flex-col items-center gap-6"
        >
          <Skeleton className="size-12 rounded-full" />
          <div className="flex w-full flex-col items-center gap-3">
            <Skeleton className="h-7 w-48" />
            <Skeleton className="h-4 w-64" />
            <Skeleton className="h-4 w-56" />
          </div>
          <Skeleton className="h-10 w-40" />
        </div>
      </main>
    )
  }

  if (id === 'welcome') {
    return <WelcomeStep progress={progress} onContinue={advance} />
  }
  if (id === 'permissions') {
    return (
      <PermissionsStep
        progress={progress}
        onContinue={advance}
        onBack={onBack}
      />
    )
  }
  if (id === 'identity') {
    return (
      <IdentityStep progress={progress} onComplete={advance} onBack={onBack} />
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
        onBack={onBack}
      />
    )
  }
  if (id === 'friend') {
    return (
      <AddFriendStep progress={progress} onContinue={advance} onBack={onBack} />
    )
  }
  return (
    <TutorialStep progress={progress} onContinue={finish} onBack={onBack} />
  )
}
