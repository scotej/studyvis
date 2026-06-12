import { useEffect, useState } from 'react'

import { type OnboardingStepProgress } from '@/components/OnboardingStep'
import { AddFriendDialog } from '@/features/friends'
import { useFriendsStore } from '@/stores/friendsStore'

import { AddFriendStepView } from './AddFriendStepView'

export type AddFriendStepProps = {
  progress?: OnboardingStepProgress
  onContinue: () => void
  onBack?: () => void
}

// The success panel only fires for friends added during this step. We snapshot
// the baseline once the friends store finishes loading, so legacy users who
// land here with friends already paired don't see "Paired" before they've
// done anything — and a fast click-through that races the load doesn't either.
export function AddFriendStep({
  progress,
  onContinue,
  onBack,
}: AddFriendStepProps) {
  const friendCount = useFriendsStore((s) => s.friends.length)
  const friendsStatus = useFriendsStore((s) => s.status)
  // Lazy initializer captures the baseline if the store is already loaded at
  // mount; otherwise the effect below latches it on the first 'ready' tick.
  const [baseline, setBaseline] = useState<number | null>(() => {
    const s = useFriendsStore.getState()
    return s.status === 'ready' ? s.friends.length : null
  })
  const [dialogOpen, setDialogOpen] = useState(false)

  useEffect(() => {
    if (baseline !== null) return
    if (friendsStatus !== 'ready') return
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot baseline snapshot once the friends store finishes loading; idempotent on re-run
    setBaseline(friendCount)
  }, [baseline, friendsStatus, friendCount])

  const justAdded = baseline !== null && friendCount > baseline

  return (
    <>
      <AddFriendStepView
        progress={progress}
        justAdded={justAdded}
        onAdd={() => setDialogOpen(true)}
        onContinue={onContinue}
        onBack={onBack}
      />
      <AddFriendDialog open={dialogOpen} onOpenChange={setDialogOpen} />
    </>
  )
}
