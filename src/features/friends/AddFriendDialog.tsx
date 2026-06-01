import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'

import { useIdentity } from '@/features/identity'
import { useFriendsStore } from '@/stores/friendsStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { strings } from '@/strings'

import {
  generatePairingCode,
  hostPairing,
  joinPairing,
  type PairedFriend,
  type PairingContext,
} from './pair'
import { encodePairLink } from './pairLink'
import {
  AddFriendDialogView,
  type AddFriendPhase,
  type AddFriendTab,
} from './AddFriendDialogView'

// Pairing no longer fails on a deadline — the room stays open until the user
// cancels, because carrying a code to a second device routinely takes longer
// than any sane timeout (the old 90s cutoff raced the user and silently lost).
// After this long with no peer, we surface a gentle "still searching" hint
// rather than giving up.
const LONG_WAIT_HINT_MS = 30_000

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
  const turnPreference = useSettingsStore((s) => s.values.turnPreference)
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

  // After a while waiting with no peer, flip on a soft hint nudging the user to
  // check the other device. This is guidance, not a failure — the pairing keeps
  // running until the user cancels.
  const isWaiting =
    phase.kind === 'host-waiting' || phase.kind === 'join-progress'
  const peerArrived =
    (phase.kind === 'host-waiting' || phase.kind === 'join-progress') &&
    phase.peerArrived
  const longWait =
    (phase.kind === 'host-waiting' || phase.kind === 'join-progress') &&
    phase.longWait === true
  useEffect(() => {
    if (!isWaiting || peerArrived || longWait) return
    const id = setTimeout(() => {
      setPhase((cur) =>
        (cur.kind === 'host-waiting' || cur.kind === 'join-progress') &&
        !cur.peerArrived &&
        !cur.longWait
          ? { ...cur, longWait: true }
          : cur
      )
    }, LONG_WAIT_HINT_MS)
    return () => clearTimeout(id)
  }, [isWaiting, peerArrived, longWait])

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
        turnPreference,
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
      const message =
        err instanceof Error
          ? err.message
          : strings.friends.addDialog.errors.pairingFailed
      setPhase({ kind: 'error', message })
      toast.error(strings.friends.addDialog.errors.pairingFailed)
    } finally {
      if (abortRef.current === ctrl) abortRef.current = null
    }
  }, [buildCtx, persistAndFinish, turnPreference])

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
          turnPreference,
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
        const message =
          err instanceof Error
            ? err.message
            : strings.friends.addDialog.errors.pairingFailed
        setPhase({ kind: 'error', message })
        toast.error(strings.friends.addDialog.errors.pairingFailed)
      } finally {
        if (abortRef.current === ctrl) abortRef.current = null
      }
    },
    [buildCtx, persistAndFinish, turnPreference]
  )

  // Copies the pairing LINK (studyvis://pair?c=…), not the raw words: it pastes
  // back into all 12 slots in one shot and is the same payload the QR encodes.
  const handleCopyLink = useCallback(async (words: string[]) => {
    try {
      await navigator.clipboard.writeText(encodePairLink(words))
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
      onCopyLink={handleCopyLink}
    />
  )
}
