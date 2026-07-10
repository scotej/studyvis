import { useEffect, useState } from 'react'
import { MailIcon } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { tokens } from '@/design/tokens'
import { strings } from '@/strings'

import type { ValidInvite } from './inbox'
import {
  usePendingInvitesStore,
  type PendingInviteEntry,
} from './pendingInvitesStore'

// #47 B1 — the persistent accept surface for incoming invites. The sonner
// toast (InboxBoot) stays as the immediate affordance; these rows survive on
// the main view until the envelope's expires_at passes, so a recipient who
// was tabbed away for a minute still sees and can accept the invite.

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
  if (entries.length === 0) return null
  return (
    <section
      aria-label={strings.friends.inbox.pending.listAriaLabel}
      className="mx-auto w-full px-4 pt-4 sm:px-6"
      style={{ maxWidth: tokens.sizes.readingMaxWidth }}
    >
      <ul className="flex flex-col gap-2">
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
  const [now, setNow] = useState(() => Date.now())

  // Refresh the countdown + drop expired rows on a slow tick, only while
  // anything is pending. Acceptance-time expiry is separately re-checked in
  // Home's runGuestJoin, so a stale row can never join a dead session.
  useEffect(() => {
    if (pending.length === 0) return
    const id = setInterval(() => {
      setNow(Date.now())
      usePendingInvitesStore.getState().prune()
    }, 10_000)
    return () => clearInterval(id)
  }, [pending.length])

  return (
    <PendingInvitesView
      entries={pending}
      now={now}
      onAccept={(entry) => onAccept(entry.invite)}
      onDismiss={(entry) => usePendingInvitesStore.getState().remove(entry.key)}
    />
  )
}
