import { create } from 'zustand'

import {
  addFriend as dbAddFriend,
  listFriends,
  removeFriend as dbRemoveFriend,
  updateLastStudied,
  type Friend,
} from '@/lib/db/friends'

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
  // Bumps last_studied_with for each peer who participated in a session that
  // just ended. Called from buildLeaveHandler after sessions_insert.
  markStudied: (edPubkeys: readonly string[], ts: number) => Promise<void>
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
      set({
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
      })
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

  markStudied: async (edPubkeys, ts) => {
    if (edPubkeys.length === 0) return
    await Promise.allSettled(
      edPubkeys.map((edPubkey) => updateLastStudied(edPubkey, ts))
    )
    try {
      const friends = await listFriends()
      set({ friends })
    } catch {
      // best-effort: leave list as-is; next mount/load will resync.
    }
  },
}))
