import { useCallback } from 'react'

import type { Friend } from '@/lib/db/friends'
import { useFriendsStore } from '@/stores/friendsStore'

import { FriendsListView } from './FriendsListView'
import { isOnline, type PresenceMap } from './presence'

export type FriendsListProps = {
  presence: PresenceMap
  onAddFriend: () => void
  onInvite: (friend: Friend) => void
  now?: number
}

export function FriendsList({
  presence,
  onAddFriend,
  onInvite,
  now,
}: FriendsListProps) {
  const friends = useFriendsStore((s) => s.friends)
  const onlineCheck = useCallback(
    (edPubkeyHex: string) => isOnline(presence, edPubkeyHex, now),
    [presence, now]
  )
  return (
    <FriendsListView
      friends={friends}
      isOnline={onlineCheck}
      onAddFriend={onAddFriend}
      onInvite={onInvite}
      now={now}
    />
  )
}
