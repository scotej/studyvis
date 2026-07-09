import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'

import { useIdentity } from '@/features/identity'
import { pairingRelaysUnreachable } from '@/lib/relayDiagnostics'
import { useFriendsStore } from '@/stores/friendsStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { strings } from '@/strings'

import { buildContactCard } from './contactCard'
import {
  generatePairingCode,
  hostPairing,
  joinPairing,
  type PairedFriend,
  type PairingContext,
} from './pair'
import {
  encodeContactLink,
  encodePairLink,
  interpretImportText,
} from './pairLink'
import {
  AddFriendDialogView,
  type AddFriendMode,
  type AddFriendPhase,
  type AddFriendTab,
  type ImportSource,
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
  // F10 — when opened from an OS-delivered studyvis://pair link, start on the
  // legacy Enter-code flow with the words prefilled. NEVER auto-connects.
  // Consumed once on the closed→open transition.
  initialTab?: AddFriendTab
  initialWords?: string[]
  // Hands a decoded friend ContactCard up to the app so the import confirm sheet
  // (safety-number check) can open. The dialog never adds a friend itself on the
  // card path — it only locates the bytes.
  onImportCard?: (cardBytes: Uint8Array, source: ImportSource) => void
}

// V1-P10 invariant: the dialog is only opened with a non-empty display name —
// onboarding step 4 collects it. We still defensively bail here in case a
// caller forgets, so we never build a card or start a pairing with an empty
// display_name.
export function AddFriendDialog({
  open,
  onOpenChange,
  initialTab,
  initialWords,
  onImportCard,
}: AddFriendDialogProps) {
  const { identity, actions: identityActions } = useIdentity()
  const addFriend = useFriendsStore((s) => s.add)
  const turnPreference = useSettingsStore((s) => s.values.turnPreference)
  const hasDisplayName = Boolean(identity?.display_name?.trim())

  const [mode, setMode] = useState<AddFriendMode>('card')
  const [tab, setTab] = useState<AddFriendTab>('host')
  const [phase, setPhase] = useState<AddFriendPhase>({ kind: 'idle' })
  const [latchedWords, setLatchedWords] = useState<string[] | undefined>(
    undefined
  )
  const [myCardLink, setMyCardLink] = useState<string | null>(null)
  const [cardBuildError, setCardBuildError] = useState(false)

  const abortRef = useRef<AbortController | null>(null)
  const successCloseRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Apply the deep-link tab/words + pick the starting mode once, on the
  // closed→open transition (React's "adjust state when a prop changes" pattern).
  // A legacy pairing deep link opens straight onto the word flow; otherwise the
  // card surface leads. Mutating initialWords while the dialog stays open does
  // nothing until the next open transition, so a late re-delivery can't retarget
  // the user's surface or replace their half-typed code.
  const [prevOpen, setPrevOpen] = useState(open)
  if (open !== prevOpen) {
    setPrevOpen(open)
    if (open) {
      if (initialWords && initialWords.length > 0) {
        setMode('legacy')
        setTab(initialTab ?? 'join')
        setLatchedWords(initialWords)
      } else {
        setMode('card')
        setTab(initialTab ?? 'host')
        setLatchedWords(undefined)
      }
    } else {
      // PR-11 — a close (user- OR parent-driven) resets the phase so a reopen
      // never shows a stale "waiting" surface. The imperative teardown of an
      // in-flight pairing (abort + timer) happens in the effect below.
      setPhase({ kind: 'idle' })
    }
  }

  useEffect(() => {
    return () => {
      abortRef.current?.abort()
      if (successCloseRef.current !== null) {
        clearTimeout(successCloseRef.current)
      }
    }
  }, [])

  // PR-11 — Radix's controlled Dialog only calls onOpenChange for USER-driven
  // closes; when the PARENT flips `open` to false it fires nothing. A
  // contact-card deep link arriving mid-pairing does exactly that
  // (Home.handleContactDeepLink → setAddOpen(false)) while this wrapper stays
  // mounted, so handleOpenChange never runs and the in-flight pairing's
  // trystero room + Nostr/MQTT relay sockets are orphaned: the AbortController
  // is never aborted and runPair's finally (room.leave) never executes. Abort
  // on any close, from either path — idempotent (the phase reset rides the
  // render-phase transition above so no setState happens in this effect).
  useEffect(() => {
    if (open) return
    abortRef.current?.abort()
    abortRef.current = null
    if (successCloseRef.current !== null) {
      clearTimeout(successCloseRef.current)
      successCloseRef.current = null
    }
  }, [open])

  // Build our own ContactCard (studyvis://add#… link) while the dialog is open.
  // It needs a keyring signature, so it's async — the surface shows a skeleton
  // until it resolves and an error banner if signing fails (e.g. outside Tauri).
  // State is only set in the async callbacks: ed25519 signing is deterministic,
  // so a link left over from a prior open is byte-identical and shows instantly
  // on reopen (no skeleton flash) until the fresh build resolves over it.
  useEffect(() => {
    if (!open || !identity || !identity.display_name) return
    let cancelled = false
    buildContactCard(
      identity.ed_pubkey_hex,
      identity.x_pubkey_hex,
      identity.display_name,
      identityActions.signWithKeyring
    )
      .then((bytes) => {
        if (cancelled) return
        setMyCardLink(encodeContactLink(bytes))
        setCardBuildError(false)
      })
      .catch(() => {
        if (!cancelled) setCardBuildError(true)
      })
    return () => {
      cancelled = true
    }
  }, [open, identity, identityActions.signWithKeyring])

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
      // F1 — after a long wait with no peer, decide WHICH hint to show. The
      // honest relay-down signal is the live socket map, not trystero's
      // `onJoinError` (which never fires on unreachable relays). Pairing races
      // Nostr + MQTT, so PR-21 judges BOTH transports: only blame the network
      // when neither Nostr nor MQTT has an open socket — otherwise pairing can
      // still complete over the transport that IS up, and we fall back to the
      // friend-side "still waiting" nudge.
      const networkDown = pairingRelaysUnreachable()
      setPhase((cur) =>
        (cur.kind === 'host-waiting' || cur.kind === 'join-progress') &&
        !cur.peerArrived &&
        !cur.longWait
          ? networkDown
            ? { ...cur, longWait: true, networkTrouble: true }
            : { ...cur, longWait: true }
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
        setMode('card')
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
        onJoinError: () => {
          setPhase((current) =>
            current.kind === 'host-waiting'
              ? { ...current, linkStalled: true }
              : current
          )
        },
        onPostArrivalStall: () => {
          setPhase((current) =>
            current.kind === 'host-waiting'
              ? { ...current, linkStalled: true }
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
          onJoinError: () => {
            setPhase((current) =>
              current.kind === 'join-progress'
                ? { ...current, linkStalled: true }
                : current
            )
          },
          onPostArrivalStall: () => {
            setPhase((current) =>
              current.kind === 'join-progress'
                ? { ...current, linkStalled: true }
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

  // Copies the pairing LINK (studyvis://pair?c=…) for the legacy word flow.
  const handleCopyLink = useCallback(async (words: string[]) => {
    try {
      await navigator.clipboard.writeText(encodePairLink(words))
      return true
    } catch {
      toast.error(strings.common.errors.copyToClipboard)
      return false
    }
  }, [])

  const handleCopyCard = useCallback(async () => {
    if (!myCardLink) return false
    try {
      await navigator.clipboard.writeText(myCardLink)
      return true
    } catch {
      toast.error(strings.common.errors.copyToClipboard)
      return false
    }
  }, [myCardLink])

  // Routes scanned/pasted/typed text: a friend's ContactCard opens the import
  // confirm sheet; a legacy pairing code drops the user into the word flow with
  // it prefilled (they still press Connect); anything else is a soft error.
  const handleImportText = useCallback(
    (text: string, source: ImportSource) => {
      const interp = interpretImportText(text)
      if (!interp) {
        toast.error(strings.friends.addDialog.card.notRecognized)
        return
      }
      if (interp.kind === 'contact') {
        onImportCard?.(interp.card, source)
        return
      }
      setMode('legacy')
      setTab('join')
      setLatchedWords(interp.words)
    },
    [onImportCard]
  )

  return (
    <AddFriendDialogView
      open={open}
      onOpenChange={handleOpenChange}
      mode={mode}
      onModeChange={setMode}
      missingDisplayName={!hasDisplayName}
      myCardLink={myCardLink}
      cardBuildError={cardBuildError}
      onCopyCard={handleCopyCard}
      onImportText={handleImportText}
      tab={tab}
      onTabChange={setTab}
      phase={phase}
      onStartHost={() => void startHost()}
      onJoinSubmit={(words) => void startJoin(words)}
      onCopyLink={handleCopyLink}
      initialWords={open ? latchedWords : undefined}
      onCancel={cancel}
    />
  )
}
