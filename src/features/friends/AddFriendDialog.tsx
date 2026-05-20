import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'

import { useIdentity } from '@/features/identity'
import { useFriendsStore } from '@/stores/friendsStore'
import { strings } from '@/strings'

import {
  generatePairingCode,
  hostPairing,
  joinPairing,
  PairTimeoutError,
  type PairedFriend,
  type PairingContext,
} from './pair'
import {
  AddFriendDialogView,
  type AddFriendPhase,
  type AddFriendTab,
} from './AddFriendDialogView'

// 90s gives a comfortable margin over typical Nostr relay rendezvous (~5–15s)
// while still surfacing a clear failure when the peer never arrives.
const PAIR_TIMEOUT_MS = 90_000

export type AddFriendDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
}

// V1-P10 invariant: the dialog is only opened with a non-empty display name —
// onboarding step 4 collects it. We still defensively bail here in case a
// caller forgets, so we never start a pairing with an empty display_name.
export function AddFriendDialog({ open, onOpenChange }: AddFriendDialogProps) {
  const { identity, actions: identityActions } = useIdentity()
  const addFriend = useFriendsStore((s) => s.add)
  const hasDisplayName = Boolean(identity?.display_name?.trim())

  const [tab, setTab] = useState<AddFriendTab>('host')
  const [phase, setPhase] = useState<AddFriendPhase>({ kind: 'idle' })

  const abortRef = useRef<AbortController | null>(null)
  const successCloseRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      abortRef.current?.abort()
      if (successCloseRef.current !== null) {
        clearTimeout(successCloseRef.current)
      }
    }
  }, [])

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next) {
        abortRef.current?.abort()
        abortRef.current = null
        if (successCloseRef.current !== null) {
          clearTimeout(successCloseRef.current)
          successCloseRef.current = null
        }
        setTab('host')
        setPhase({ kind: 'idle' })
      }
      onOpenChange(next)
    },
    [onOpenChange]
  )

  const cancel = useCallback(() => {
    handleOpenChange(false)
  }, [handleOpenChange])

  const persistAndFinish = useCallback(
    async (friend: PairedFriend) => {
      try {
        await addFriend(
          friend.edPubkey,
          friend.xPubkey,
          friend.name,
          Date.now()
        )
        setPhase({
          kind: 'success',
          name: friend.name || strings.friends.addDialog.defaultFriendName,
        })
        successCloseRef.current = setTimeout(() => {
          successCloseRef.current = null
          handleOpenChange(false)
        }, 1500)
      } catch (err) {
        const message =
          err instanceof Error
            ? err.message
            : strings.friends.addDialog.errors.savingFriend
        setPhase({ kind: 'error', message })
        toast.error(strings.friends.addDialog.errors.savingFriend)
      }
    },
    [addFriend, handleOpenChange]
  )

  const buildCtx = useCallback((): PairingContext | null => {
    if (!identity || !identity.display_name) return null
    return {
      edPubHex: identity.ed_pubkey_hex,
      xPubHex: identity.x_pubkey_hex,
      displayName: identity.display_name,
      sign: identityActions.signWithKeyring,
    }
  }, [identity, identityActions.signWithKeyring])

  const startHost = useCallback(async () => {
    const ctx = buildCtx()
    if (!ctx) return
    const words = generatePairingCode()
    const ctrl = new AbortController()
    abortRef.current = ctrl
    setPhase({ kind: 'host-waiting', words, peerArrived: false })
    try {
      const friend = await hostPairing(words, ctx, {
        signal: ctrl.signal,
        timeoutMs: PAIR_TIMEOUT_MS,
        onPeerJoinedTopic: () => {
          setPhase((current) =>
            current.kind === 'host-waiting'
              ? { ...current, peerArrived: true }
              : current
          )
        },
      })
      await persistAndFinish(friend)
    } catch (err) {
      if (ctrl.signal.aborted) return
      if (err instanceof PairTimeoutError) {
        setPhase({ kind: 'host-timeout', words })
      } else {
        const message =
          err instanceof Error
            ? err.message
            : strings.friends.addDialog.errors.pairingFailed
        setPhase({ kind: 'error', message })
        toast.error(strings.friends.addDialog.errors.pairingFailed)
      }
    } finally {
      if (abortRef.current === ctrl) abortRef.current = null
    }
  }, [buildCtx, persistAndFinish])

  const startJoin = useCallback(
    async (words: string[]) => {
      const ctx = buildCtx()
      if (!ctx) return
      const ctrl = new AbortController()
      abortRef.current = ctrl
      setPhase({ kind: 'join-progress', peerArrived: false })
      try {
        const friend = await joinPairing(words, ctx, {
          signal: ctrl.signal,
          timeoutMs: PAIR_TIMEOUT_MS,
          onPeerJoinedTopic: () => {
            setPhase((current) =>
              current.kind === 'join-progress'
                ? { ...current, peerArrived: true }
                : current
            )
          },
        })
        await persistAndFinish(friend)
      } catch (err) {
        if (ctrl.signal.aborted) return
        if (err instanceof PairTimeoutError) {
          setPhase({ kind: 'join-timeout' })
        } else {
          const message =
            err instanceof Error
              ? err.message
              : strings.friends.addDialog.errors.pairingFailed
          setPhase({ kind: 'error', message })
          toast.error(strings.friends.addDialog.errors.pairingFailed)
        }
      } finally {
        if (abortRef.current === ctrl) abortRef.current = null
      }
    },
    [buildCtx, persistAndFinish]
  )

  const handleCopyWords = useCallback(async (words: string[]) => {
    try {
      await navigator.clipboard.writeText(words.join(' '))
      return true
    } catch {
      toast.error(strings.common.errors.copyToClipboard)
      return false
    }
  }, [])

  return (
    <AddFriendDialogView
      open={open}
      onOpenChange={handleOpenChange}
      tab={tab}
      onTabChange={setTab}
      phase={phase}
      missingDisplayName={!hasDisplayName}
      onStartHost={() => void startHost()}
      onJoinSubmit={(words) => void startJoin(words)}
      onCancel={cancel}
      onCopyWords={handleCopyWords}
    />
  )
}
