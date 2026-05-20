import { PlusIcon } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { tokens } from '@/design/tokens'
import { cn } from '@/lib/utils'
import { strings } from '@/strings'
import type { Friend } from '@/lib/db/friends'

export type FriendsListViewProps = {
  friends: ReadonlyArray<Friend>
  isOnline: (edPubkeyHex: string) => boolean
  onAddFriend: () => void
  onInvite: (friend: Friend) => void
  now?: number
}

export function FriendsListView({
  friends,
  isOnline,
  onAddFriend,
  onInvite,
  now,
}: FriendsListViewProps) {
  if (friends.length === 0) {
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
      <ul className="divide-y divide-border-subtle rounded-lg border border-border-default bg-bg-surface">
        {friends.map((friend) => (
          <FriendRow
            key={friend.ed_pubkey_hex}
            friend={friend}
            online={isOnline(friend.ed_pubkey_hex)}
            now={now}
            onInvite={() => onInvite(friend)}
          />
        ))}
      </ul>
    </section>
  )
}

type FriendRowProps = {
  friend: Friend
  online: boolean
  now?: number
  onInvite: () => void
}

function FriendRow({ friend, online, now, onInvite }: FriendRowProps) {
  const name = friend.display_name?.trim() || shortPubkey(friend.ed_pubkey_hex)
  const last = formatLastTogether(friend.last_studied_with, now)
  return (
    <li className="group grid grid-cols-[auto_1fr_auto] items-center gap-x-4 gap-y-1 px-5 py-4">
      <PresenceDot online={online} />
      <div className="flex min-w-0 flex-col">
        <span className="truncate text-base font-medium text-text-primary">
          {name}
        </span>
        <span className="text-xs text-text-secondary">
          {online
            ? strings.friends.list.available
            : strings.friends.list.offline}
        </span>
      </div>
      <div className="flex items-center justify-end gap-4">
        <span className="hidden text-xs text-text-secondary sm:inline">
          {last}
        </span>
        {online ? (
          <Button
            variant="default"
            size="sm"
            onClick={onInvite}
            aria-label={strings.friends.list.inviteAriaLabel(name)}
            className="pointer-events-none opacity-0 transition-opacity duration-fast group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100"
          >
            {strings.friends.list.inviteCta}
          </Button>
        ) : null}
      </div>
    </li>
  )
}

function PresenceDot({ online }: { online: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-flex size-2.5 shrink-0 rounded-full',
        online
          ? 'bg-status-online'
          : 'border-2 border-status-offline bg-transparent'
      )}
    />
  )
}

function shortPubkey(hex: string): string {
  if (hex.length <= 10) return hex
  return `${hex.slice(0, 8)}…`
}

function formatLastTogether(
  ts: number | null | undefined,
  now: number | undefined
): string {
  const last = strings.friends.list.lastTogether
  if (!ts) return last.never
  const reference = now ?? Date.now()
  const deltaMs = Math.max(0, reference - ts)
  const day = 24 * 60 * 60 * 1000
  const days = Math.floor(deltaMs / day)
  if (days === 0) return last.today
  if (days === 1) return last.yesterday
  if (days < 7) return last.daysAgo(days)
  if (days < 30) {
    const weeks = Math.max(1, Math.floor(days / 7))
    return last.weeksAgo(weeks)
  }
  if (days < 365) {
    const months = Math.max(1, Math.floor(days / 30))
    return last.monthsAgo(months)
  }
  const years = Math.max(1, Math.floor(days / 365))
  return last.yearsAgo(years)
}
