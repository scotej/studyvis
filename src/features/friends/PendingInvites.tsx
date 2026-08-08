import { useEffect, useId, useState } from 'react'
import { MailIcon } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { tokens } from '@/design/tokens'
import { useIdentityStore } from '@/stores/identityStore'
import { strings } from '@/strings'

import type { ValidInvite } from './inbox'
import {
  usePendingInvitesStore,
  type PendingInviteEntry,
} from './pendingInvitesStore'

export type PendingInvitesViewProps = {
  entries: ReadonlyArray<PendingInviteEntry>
  now: number
  onAccept: (entry: PendingInviteEntry) => void
  onDismiss: (entry: PendingInviteEntry) => void
}

function senderName(invite: ValidInvite): string {
  return (
    invite.payload.our_display_name?.trim() ||
    strings.friends.inbox.senderFallback
  )
}

export function PendingInvitesView({
  entries,
  now,
  onAccept,
  onDismiss,
}: PendingInvitesViewProps) {
  const headingId = useId()
  if (entries.length === 0) return null
  return (
    <section
      aria-labelledby={headingId}
      className="mx-auto w-full shrink-0 px-4 py-4 sm:px-6"
      style={{ maxWidth: tokens.sizes.readingMaxWidth }}
    >
      <div className="mb-2 flex items-center justify-between gap-3">
        <h2 id={headingId} className="text-sm font-semibold text-text-primary">
          {strings.friends.inbox.pending.listAriaLabel}
        </h2>
        <span
          className="flex size-5 items-center justify-center rounded-full bg-accent-default text-xs font-medium text-text-inverse"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          <span className="sr-only">
            {strings.friends.inbox.pending.listAriaLabel}
          </span>{' '}
          {entries.length}
        </span>
      </div>
      <ul className="flex max-h-64 flex-col gap-2 overflow-y-auto pr-1">
        {entries.map((entry) => {
          const name = senderName(entry.invite)
          const minutesLeft = Math.max(
            1,
            Math.ceil((entry.invite.payload.expires_at - now) / 60_000)
          )
          return (
            <li
              key={entry.key}
              className="flex items-center justify-between gap-3 rounded-lg border border-border-subtle bg-bg-surface px-4 py-3"
            >
              <span className="flex min-w-0 items-center gap-3">
                <MailIcon
                  className="size-4 shrink-0 text-accent-default"
                  aria-hidden="true"
                />
                <span className="flex min-w-0 flex-col">
                  <span className="truncate text-sm text-text-primary">
                    {strings.friends.inbox.inviteBody(name)}
                  </span>
                  <span className="text-xs text-text-muted">
                    {strings.friends.inbox.pending.expiresIn(minutesLeft)}
                  </span>
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => onDismiss(entry)}
                  aria-label={strings.friends.inbox.pending.dismissAriaLabel(
                    name
                  )}
                >
                  {strings.friends.inbox.pending.dismissCta}
                </Button>
                <Button
                  type="button"
                  variant="default"
                  size="sm"
                  onClick={() => onAccept(entry)}
                  aria-label={strings.friends.inbox.pending.acceptAriaLabel(
                    name
                  )}
                >
                  {strings.friends.inbox.acceptAction}
                </Button>
              </span>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

export type PendingInvitesProps = {
  onAccept: (invite: ValidInvite) => void
}

export function PendingInvites({ onAccept }: PendingInvitesProps) {
  const pending = usePendingInvitesStore((s) => s.pending)
  const pendingIdentityEdPubkeyHex = usePendingInvitesStore(
    (s) => s.identityEdPubkeyHex
  )
  const identityEdPubkeyHex = useIdentityStore(
    (s) => s.identity?.ed_pubkey_hex ?? null
  )
  const [now, setNow] = useState(() => Date.now())

  const activeIdentity = identityEdPubkeyHex?.toLowerCase() ?? null
  const entries =
    activeIdentity && pendingIdentityEdPubkeyHex === activeIdentity
      ? pending
      : []

  useEffect(() => {
    if (entries.length === 0) return
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reseed the display clock when the inbox changes from empty to non-empty
    setNow(Date.now())
    const id = setInterval(() => {
      setNow(Date.now())
      usePendingInvitesStore.getState().prune()
    }, 10_000)
    return () => clearInterval(id)
  }, [entries.length])

  return (
    <PendingInvitesView
      entries={entries}
      now={now}
      onAccept={(entry) => {
        const state = usePendingInvitesStore.getState()
        if (
          !activeIdentity ||
          state.identityEdPubkeyHex !== activeIdentity ||
          !state.pending.some(
            (candidate) =>
              candidate.key === entry.key &&
              candidate.invite.payload.sig === entry.invite.payload.sig
          )
        ) {
          return
        }
        onAccept(entry.invite)
      }}
      onDismiss={(entry) => {
        const state = usePendingInvitesStore.getState()
        if (
          activeIdentity &&
          state.identityEdPubkeyHex === activeIdentity &&
          state.pending.some(
            (candidate) =>
              candidate.key === entry.key &&
              candidate.invite.payload.sig === entry.invite.payload.sig
          )
        ) {
          state.remove(entry.key)
        }
      }}
    />
  )
}
