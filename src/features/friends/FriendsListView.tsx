import { PlusIcon } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { tokens } from '@/design/tokens'
import { cn } from '@/lib/utils'
import { strings } from '@/strings'
import type { Friend } from '@/lib/db/friends'

import { formatLastTogether, presenceLabel } from './friendLabels'
import type { FriendPresenceState } from './presence'
import { shortPubkey } from './shortPubkey'

export type FriendsListViewProps = {
  friends: ReadonlyArray<Friend>
  // I74 — the row renders richer state than a boolean: online (direct),
  // online-limited (relay heartbeats only — sessions likely won't connect),
  // and offline with session-scoped last-seen recency.
  presenceOf: (edPubkeyHex: string) => FriendPresenceState
  onAddFriend: () => void
  onInvite: (friend: Friend) => void
  // I74 — deep-link into Settings → Network from the limited-connection hint.
  // Optional so Storybook can render the hint without a live settings shell.
  onOpenNetworkSettings?: () => void
  now?: number
}

export function FriendsListView({
  friends,
  presenceOf,
  onAddFriend,
  onInvite,
  onOpenNetworkSettings,
  now,
}: FriendsListViewProps) {
  if (friends.length === 0) {
    // U4 — the centered card is the sole CTA in the empty state (it carries the
    // explanatory copy); the header [+ Add friend] is dropped here to honor
    // §10's one-primary-action rule, and returns in the non-empty state below.
    return (
      <section
        aria-labelledby="friends-heading"
        className="mx-auto flex w-full flex-col gap-8 px-4 py-4 sm:px-6 sm:py-6"
        style={{ maxWidth: tokens.sizes.readingMaxWidth }}
      >
        <header className="flex items-center justify-between">
          <h2
            id="friends-heading"
            className="text-lg font-semibold tracking-tight text-text-primary"
          >
            {strings.friends.list.heading}
          </h2>
        </header>
        <div className="rounded-lg border border-border-default bg-bg-surface p-8 text-center">
          <p className="text-sm text-text-secondary">
            {strings.friends.list.empty}
          </p>
          <Button
            className="mt-4"
            onClick={onAddFriend}
            variant="default"
            size="sm"
          >
            <PlusIcon /> {strings.friends.list.addCta}
          </Button>
        </div>
      </section>
    )
  }

  const states = new Map(
    friends.map((friend) => [
      friend.ed_pubkey_hex,
      presenceOf(friend.ed_pubkey_hex),
    ])
  )
  const anyLimited = [...states.values()].some(
    (s) => s.state === 'online' && s.limited
  )

  return (
    <section
      aria-labelledby="friends-heading"
      className="mx-auto flex w-full flex-col gap-8 px-4 py-4 sm:px-6 sm:py-6"
      style={{ maxWidth: tokens.sizes.readingMaxWidth }}
    >
      <header className="flex items-center justify-between">
        <h2
          id="friends-heading"
          className="text-lg font-semibold tracking-tight text-text-primary"
        >
          {strings.friends.list.heading}
        </h2>
        <Button onClick={onAddFriend} variant="default" size="sm">
          <PlusIcon /> {strings.friends.list.addCta}
        </Button>
      </header>
      {anyLimited ? (
        <LimitedConnectionHint onOpen={onOpenNetworkSettings} />
      ) : null}
      <ul className="divide-y divide-border-subtle rounded-lg border border-border-default bg-bg-surface">
        {friends.map((friend) => (
          <FriendRow
            key={friend.ed_pubkey_hex}
            friend={friend}
            presence={
              states.get(friend.ed_pubkey_hex) ?? {
                state: 'offline',
                lastSeenAt: null,
              }
            }
            now={now}
            onInvite={() => onInvite(friend)}
          />
        ))}
      </ul>
    </section>
  )
}

// I74 — one hint for the whole list (not per row): the remedy is global
// (configure a TURN relay), and repeating it per friend would drown the list.
function LimitedConnectionHint({ onOpen }: { onOpen?: () => void }) {
  const copy = strings.friends.list.limitedHint
  return (
    // role="status": the hint appears/disappears with live presence state,
    // so screen readers need the polite announcement (DESIGN §11).
    <div
      role="status"
      className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border-default bg-bg-surface px-4 py-3"
    >
      <p className="min-w-0 flex-1 text-xs text-text-secondary">{copy.body}</p>
      {onOpen ? (
        <Button variant="outline" size="sm" onClick={onOpen}>
          {copy.cta}
        </Button>
      ) : null}
    </div>
  )
}

type FriendRowProps = {
  friend: Friend
  presence: FriendPresenceState
  now?: number
  onInvite: () => void
}

function FriendRow({ friend, presence, now, onInvite }: FriendRowProps) {
  const name = friend.display_name?.trim() || shortPubkey(friend.ed_pubkey_hex)
  const last = formatLastTogether(friend.last_studied_with, now)
  const online = presence.state === 'online'
  const limited = presence.state === 'online' && presence.limited
  return (
    <li className="group grid grid-cols-[auto_1fr_auto] items-center gap-x-4 gap-y-1 px-5 py-4">
      <PresenceDot online={online} limited={limited} />
      <div className="flex min-w-0 flex-col">
        <span className="truncate text-base font-medium text-text-primary">
          {name}
        </span>
        <span
          className="text-xs text-text-secondary"
          title={limited ? strings.friends.list.limitedTitle : undefined}
        >
          {presenceLabel(presence, now)}
        </span>
      </div>
      <div className="flex items-center justify-end gap-4">
        <span className="hidden text-xs text-text-secondary sm:inline">
          {last}
        </span>
        {online ? (
          // U1 — always-visible at reduced emphasis (outline) so the primary
          // action is discoverable on first look and reachable on touch, then
          // elevates to the accent fill on row hover / keyboard focus. Was
          // opacity-0/pointer-events-none until group-hover, which made invite
          // invisible at rest and impossible without a pointer.
          <Button
            variant="outline"
            size="sm"
            onClick={onInvite}
            aria-label={strings.friends.list.inviteAriaLabel(name)}
            className="group-hover:border-transparent group-hover:bg-accent-default group-hover:text-text-inverse group-hover:hover:bg-accent-hover group-focus-within:border-transparent group-focus-within:bg-accent-default group-focus-within:text-text-inverse"
          >
            {strings.friends.list.inviteCta}
          </Button>
        ) : null}
      </div>
    </li>
  )
}

function PresenceDot({
  online,
  limited,
}: {
  online: boolean
  limited: boolean
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-flex size-2.5 shrink-0 rounded-full',
        online
          ? limited
            ? 'bg-status-warning'
            : 'bg-status-online'
          : 'border-2 border-status-offline bg-transparent'
      )}
    />
  )
}
