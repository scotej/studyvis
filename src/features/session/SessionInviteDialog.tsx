import { useEffect, useRef, useState } from 'react'
import { UserPlusIcon } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import type { Friend } from '@/lib/db/friends'
import { strings } from '@/strings'

import { invitableFriends } from './invitableFriends'

// #47 A2 — the mid-session online-friends picker. hostSession() flips the
// store to 'active' synchronously and Home unmounts the FriendsList (the only
// other Invite surface), so without this the first Invite click locked the
// host into a 1:1 session — even though the host-enforced 4-user cap, the
// "session is full" copy, and inviteToCurrentSession's active-host branch all
// assume mid-session invites work (PLAN §5's "2–4 user mesh sessions").
// Pure view: friends/presence/session state are injected so Storybook and
// tests need no stores.

export type SessionInviteDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  friends: ReadonlyArray<Friend>
  isOnline: (edPubkeyHex: string) => boolean
  // ed_pubkey_hex of every peer currently in the session (from signed-hello
  // bindings) — they're filtered out of the picker.
  inSessionEdPubkeys: ReadonlySet<string>
  // Live remote-peer count is at MAX_REMOTE_PEERS: show the full-session
  // notice instead of rows the host cap would reject anyway.
  full: boolean
  // True means the envelope was sent; an unconfirmed ACK is still a send.
  // False leaves the row available for another attempt.
  onInvite: (friend: Friend) => Promise<boolean>
}

export function SessionInviteDialog({
  open,
  onOpenChange,
  friends,
  isOnline,
  inSessionEdPubkeys,
  full,
  onInvite,
}: SessionInviteDialogProps) {
  // Per-open invited set so a row flips to "Invited" after the click but a
  // reopened dialog starts fresh (an invite may have expired meanwhile).
  // Same adjust-state-on-prop-change pattern as TopicGateModal.
  const [invited, setInvited] = useState<ReadonlySet<string>>(new Set())
  const [sending, setSending] = useState<ReadonlySet<string>>(new Set())
  const [wasOpen, setWasOpen] = useState(open)
  const generation = useRef(0)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) {
      setInvited(new Set())
      setSending(new Set())
    }
  }

  useEffect(
    () => () => {
      generation.current += 1
    },
    [open]
  )

  const rows = invitableFriends(friends, isOnline, inSessionEdPubkeys)

  const handleInvite = async (friend: Friend) => {
    const ed = friend.ed_pubkey_hex
    const startedIn = generation.current
    setSending((cur) => new Set(cur).add(ed))
    try {
      const sent = await onInvite(friend)
      if (sent && generation.current === startedIn) {
        setInvited((cur) => new Set(cur).add(ed))
      }
    } catch {
      // The caller reports send errors; keep the row available for a retry.
    } finally {
      if (generation.current === startedIn) {
        setSending((cur) => {
          const next = new Set(cur)
          next.delete(ed)
          return next
        })
      }
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby="session-invite-description">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <span
              aria-hidden="true"
              className="flex size-9 items-center justify-center rounded-full bg-accent-default/15 text-accent-default"
            >
              <UserPlusIcon className="size-5" />
            </span>
            <DialogTitle>{strings.session.invite.dialogTitle}</DialogTitle>
          </div>
          <DialogDescription id="session-invite-description">
            {strings.session.invite.dialogDescription}
          </DialogDescription>
        </DialogHeader>
        {full ? (
          <p className="text-sm text-text-secondary">{strings.session.full}</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-text-secondary">
            {strings.session.invite.emptyOnline}
          </p>
        ) : (
          <ul
            className="flex flex-col gap-2"
            aria-label={strings.session.invite.listAriaLabel}
          >
            {rows.map((friend) => {
              const name =
                friend.display_name?.trim() ||
                strings.friends.addDialog.defaultFriendName
              const alreadyInvited = invited.has(friend.ed_pubkey_hex)
              const isSending = sending.has(friend.ed_pubkey_hex)
              return (
                <li
                  key={friend.ed_pubkey_hex}
                  className="flex items-center justify-between gap-3 rounded-md border border-border-subtle bg-bg-surface px-3 py-2"
                >
                  <span className="truncate text-sm text-text-primary">
                    {name}
                  </span>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={alreadyInvited || isSending}
                    onClick={() => void handleInvite(friend)}
                    aria-label={
                      isSending
                        ? strings.session.invite.sendingAriaLabel(name)
                        : alreadyInvited
                          ? strings.session.invite.invitedAriaLabel(name)
                          : strings.session.invite.rowInviteAriaLabel(name)
                    }
                  >
                    {isSending
                      ? strings.session.invite.sendingLabel
                      : alreadyInvited
                        ? strings.session.invite.invitedLabel
                        : strings.session.invite.rowCta}
                  </Button>
                </li>
              )
            })}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  )
}
