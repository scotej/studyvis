import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'

import { useIdentity } from '@/features/identity'
import { pairFingerprint, shortEdFingerprint } from '@/lib/crypto/topics'
import { useFriendsStore } from '@/stores/friendsStore'
import { strings } from '@/strings'

import { readContactCard, sanitizeDisplayName } from './contactCard'
import {
  ContactImportView,
  type ContactImportOutcome,
} from './ContactImportView'

export type ContactImportSource = 'qr' | 'remote'

export type ContactImportDialogProps = {
  open: boolean
  // Raw ContactCard bytes located by scan/paste/deep-link. Parse, signature
  // verify, and self-guard all happen HERE (before any confirm UI renders), so
  // a hostile card never shows a fabricated safety number.
  cardBytes: Uint8Array | null
  // 'qr' = scanned in person (safety number optional); 'remote' = paste / link /
  // deep-link (safety number must be affirmed before Add is enabled).
  source: ContactImportSource
  onOpenChange: (open: boolean) => void
}

const ADDED_AUTOCLOSE_MS = 2500

export function ContactImportDialog({
  open,
  cardBytes,
  source,
  onOpenChange,
}: ContactImportDialogProps) {
  const { identity } = useIdentity()
  const localEd = identity?.ed_pubkey_hex ?? null
  const addFriend = useFriendsStore((s) => s.add)
  const copy = strings.friends.addDialog.importCard

  const [acked, setAcked] = useState(false)
  const [saving, setSaving] = useState(false)
  const [savedName, setSavedName] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const owner = useRef({ active: false })

  // A fresh card resets the transient confirm state (ack, saved, error). Done in
  // render (React's "adjust state when a prop changes" pattern) rather than an
  // effect, so the reset lands before the first paint of the new card.
  const [previous, setPrevious] = useState({ cardBytes, open, localEd, source })
  if (
    cardBytes !== previous.cardBytes ||
    open !== previous.open ||
    localEd !== previous.localEd ||
    source !== previous.source
  ) {
    setPrevious({ cardBytes, open, localEd, source })
    setAcked(false)
    setSavedName(null)
    setSaveError(null)
    setSaving(false)
  }

  // #383 — an add belongs to this exact confirmation lifetime. Invalidate it
  // before another card/identity can paint, including close/reopen of one card.
  useLayoutEffect(() => {
    const operation = { active: open }
    owner.current = operation
    return () => {
      operation.active = false
      if (closeTimer.current !== null) {
        clearTimeout(closeTimer.current)
        closeTimer.current = null
      }
    }
  }, [cardBytes, open, localEd, source])

  const read = useMemo(() => {
    if (!open || !cardBytes || !localEd) return null
    return readContactCard(cardBytes, localEd)
  }, [open, cardBytes, localEd])

  const outcome: ContactImportOutcome | null = useMemo(() => {
    if (savedName !== null) return { kind: 'added', name: savedName }
    if (saveError) return { kind: 'error', message: saveError }
    if (!read) return null
    if (!read.ok) {
      const message =
        read.reason === 'future-version'
          ? copy.futureVersionError
          : read.reason === 'tampered'
            ? copy.tamperError
            : copy.corruptError
      return { kind: 'error', message }
    }
    if (read.isSelf) return { kind: 'error', message: copy.selfError }
    return {
      kind: 'confirm',
      name: sanitizeDisplayName(read.card.name) || copy.fallbackName,
      shortId: shortEdFingerprint(read.card.edPubkey),
      fingerprint: localEd ? pairFingerprint(localEd, read.card.edPubkey) : '',
      requireAck: source === 'remote',
    }
  }, [savedName, saveError, read, localEd, source, copy])

  const handleConfirm = useCallback(async () => {
    if (!open || saving || !read || !read.ok || read.isSelf) return
    const operation = owner.current
    const persistName = sanitizeDisplayName(read.card.name)
    setSaving(true)
    try {
      await addFriend(
        read.card.edPubkey,
        read.card.xPubkey,
        persistName,
        Date.now()
      )
      if (!operation.active) return
      setSavedName(persistName || copy.fallbackName)
      closeTimer.current = setTimeout(() => {
        closeTimer.current = null
        if (operation.active) onOpenChange(false)
      }, ADDED_AUTOCLOSE_MS)
    } catch {
      if (!operation.active) return
      setSaveError(copy.savingError)
      toast.error(copy.savingError)
    } finally {
      if (operation.active) setSaving(false)
    }
  }, [open, saving, read, addFriend, copy, onOpenChange])

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next) owner.current.active = false
      if (!next && closeTimer.current !== null) {
        clearTimeout(closeTimer.current)
        closeTimer.current = null
      }
      onOpenChange(next)
    },
    [onOpenChange]
  )

  return (
    <ContactImportView
      open={open}
      onOpenChange={handleOpenChange}
      outcome={outcome}
      acked={acked}
      onAckChange={setAcked}
      saving={saving}
      onConfirm={() => void handleConfirm()}
      onCancel={() => handleOpenChange(false)}
    />
  )
}
