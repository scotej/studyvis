import { useCallback } from 'react'

import type { Friend } from '@/lib/db/friends'
import { useFriendsStore } from '@/stores/friendsStore'

import { FriendsListView } from './FriendsListView'
import { presenceState, type PresenceMap } from './presence'

export type FriendsListProps = {
  presence: PresenceMap
  onAddFriend: () => void
  onInvite: (friend: Friend) => void
  // I74 — the limited-connection hint deep-links to Settings → Network.
  onOpenNetworkSettings?: () => void
  now?: number
}

export function FriendsList({
  presence,
  onAddFriend,
  onInvite,
  onOpenNetworkSettings,
  now,
}: FriendsListProps) {
  const friends = useFriendsStore((s) => s.friends)
  const presenceOf = useCallback(
    (edPubkeyHex: string) => presenceState(presence, edPubkeyHex, now),
    [presence, now]
  )
  return (
    <FriendsListView
      friends={friends}
      presenceOf={presenceOf}
      onAddFriend={onAddFriend}
      onInvite={onInvite}
      onOpenNetworkSettings={onOpenNetworkSettings}
      now={now}
    />
  )
}
