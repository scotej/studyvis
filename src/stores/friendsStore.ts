// Zustand store mirroring the SQLite friends table. `add` re-lists from the
// DB after insert (canonical ordering); `remove` filters locally
// (optimistic); `markStudied` is best-effort and lets a failed re-list
// resync on the next load.

import { create } from 'zustand'

import {
  addFriend as dbAddFriend,
  listFriends,
  removeFriend as dbRemoveFriend,
  updateLastStudied,
  type Friend,
} from '@/lib/db/friends'
import { strings } from '@/strings'
import { logger } from '@/lib/log'

const log = logger.child('friends')

export type FriendsStatus = 'idle' | 'loading' | 'ready' | 'error'

type FriendsState = {
  friends: Friend[]
  status: FriendsStatus
  error: string | null
  load: () => Promise<void>
  add: (
    edPubkey: string,
    xPubkey: string,
    name: string,
    ts: number
  ) => Promise<void>
  remove: (edPubkey: string) => Promise<void>
  // Compatibility helper for peers that share one interval-close timestamp.
  markStudied: (edPubkeys: readonly string[], ts: number) => Promise<void>
  // Precise variant for peers whose overlap intervals ended at different
  // wall-clock times during one still-running local session.
  markStudiedAt: (entries: readonly PeerStudiedAt[]) => Promise<void>
}

export type PeerStudiedAt = { edPubkey: string; ts: number }

async function persistStudiedAt(
  entries: readonly PeerStudiedAt[],
  setFriends: (friends: Friend[]) => void
): Promise<void> {
  const latestByPeer = new Map<string, number>()
  for (const { edPubkey, ts } of entries) {
    latestByPeer.set(edPubkey, Math.max(latestByPeer.get(edPubkey) ?? ts, ts))
  }
  if (latestByPeer.size === 0) return
  await Promise.allSettled(
    Array.from(latestByPeer, ([edPubkey, ts]) =>
      updateLastStudied(edPubkey, ts)
    )
  )
  try {
    const friends = await listFriends()
    setFriends(friends)
  } catch {
    // best-effort: leave list as-is; next mount/load will resync.
  }
}

export const useFriendsStore = create<FriendsState>((set, get) => ({
  friends: [],
  status: 'idle',
  error: null,

  load: async () => {
    if (get().status === 'loading') return
    set({ status: 'loading', error: null })
    try {
      const friends = await listFriends()
      set({ friends, status: 'ready' })
    } catch (err) {
      // Tauri rejects with a plain string — storing it verbatim would hand
      // raw rusqlite text to whichever surface renders `error` next. Keep
      // the raw value in the log; the store carries friendly copy.
      log.error('list.failed', { cmd: 'friends_list', err })
      set({ status: 'error', error: strings.friends.loadError })
    }
  },

  add: async (edPubkey, xPubkey, name, ts) => {
    await dbAddFriend(edPubkey, xPubkey, name, ts)
    const friends = await listFriends()
    set({ friends })
  },

  remove: async (edPubkey) => {
    await dbRemoveFriend(edPubkey)
    set((state) => ({
      friends: state.friends.filter((f) => f.ed_pubkey_hex !== edPubkey),
    }))
  },

  markStudied: async (edPubkeys, ts) =>
    persistStudiedAt(
      edPubkeys.map((edPubkey) => ({ edPubkey, ts })),
      (friends) => set({ friends })
    ),
  markStudiedAt: async (entries) =>
    persistStudiedAt(entries, (friends) => set({ friends })),
}))
