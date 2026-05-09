import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'

import { useIdentity } from '@/features/identity'
import { useFriendsStore } from '@/stores/friendsStore'

import {
  generatePairingCode,
  hostPairing,
  joinPairing,
  type PairedFriend,
  type PairingContext,
} from './pair'
import {
  AddFriendDialogView,
  type AddFriendPhase,
  type AddFriendTab,
  type DisplayNamePhase,
} from './AddFriendDialogView'

export type AddFriendDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function AddFriendDialog({ open, onOpenChange }: AddFriendDialogProps) {
  const { identity, actions: identityActions } = useIdentity()
  const addFriend = useFriendsStore((s) => s.add)

  const [tab, setTab] = useState<AddFriendTab>('host')
  const [phase, setPhase] = useState<AddFriendPhase>({ kind: 'idle' })
  const [nameSubmitting, setNameSubmitting] = useState(false)
  const [nameError, setNameError] = useState<string | null>(null)

  const abortRef = useRef<AbortController | null>(null)
  const successCloseRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const cancel = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    setPhase({ kind: 'idle' })
  }, [])

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
        setNameError(null)
        setNameSubmitting(false)
      }
      onOpenChange(next)
    },
    [onOpenChange]
  )

  const persistAndFinish = useCallback(
    async (friend: PairedFriend) => {
      try {
        await addFriend(
          friend.edPubkey,
          friend.xPubkey,
          friend.name,
          Date.now()
        )
        setPhase({ kind: 'success', name: friend.name || 'your friend' })
        successCloseRef.current = setTimeout(() => {
          successCloseRef.current = null
          handleOpenChange(false)
        }, 1500)
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Could not save friend.'
        setPhase({ kind: 'error', message })
        toast.error("Couldn't save your new friend.")
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
    setPhase({ kind: 'host-waiting', words })
    try {
      const friend = await hostPairing(words, ctx, { signal: ctrl.signal })
      await persistAndFinish(friend)
    } catch (err) {
      if (ctrl.signal.aborted) return
      const message = err instanceof Error ? err.message : 'Pairing failed.'
      setPhase({ kind: 'error', message })
      toast.error('Pairing failed.')
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
      setPhase({ kind: 'join-progress' })
      try {
        const friend = await joinPairing(words, ctx, { signal: ctrl.signal })
        await persistAndFinish(friend)
      } catch (err) {
        if (ctrl.signal.aborted) return
        const message = err instanceof Error ? err.message : 'Pairing failed.'
        setPhase({ kind: 'error', message })
        toast.error('Pairing failed.')
      } finally {
        if (abortRef.current === ctrl) abortRef.current = null
      }
    },
    [buildCtx, persistAndFinish]
  )

  const handleSetDisplayName = useCallback(
    async (name: string) => {
      setNameSubmitting(true)
      setNameError(null)
      try {
        await identityActions.setDisplayName(name)
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Could not save name.'
        setNameError(message)
      } finally {
        setNameSubmitting(false)
      }
    },
    [identityActions]
  )

  const handleCopyWords = useCallback(async (words: string[]) => {
    try {
      await navigator.clipboard.writeText(words.join(' '))
      return true
    } catch {
      toast.error("Couldn't copy to clipboard.")
      return false
    }
  }, [])

  const displayNamePhase: DisplayNamePhase = identity?.display_name
    ? { kind: 'collected' }
    : { kind: 'collecting', submitting: nameSubmitting, error: nameError }

  return (
    <AddFriendDialogView
      open={open}
      onOpenChange={handleOpenChange}
      tab={tab}
      onTabChange={setTab}
      phase={phase}
      displayNamePhase={displayNamePhase}
      onSetDisplayName={handleSetDisplayName}
      onStartHost={() => void startHost()}
      onJoinSubmit={(words) => void startJoin(words)}
      onCancel={cancel}
      onCopyWords={handleCopyWords}
    />
  )
}
