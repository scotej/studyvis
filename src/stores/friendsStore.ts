import { create } from 'zustand'

import {
  addFriend as dbAddFriend,
  listFriends,
  removeFriend as dbRemoveFriend,
  updateLastStudied as dbUpdateLastStudied,
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
  markStudied: (edPubkey: string, ts: number) => Promise<void>
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

  markStudied: async (edPubkey, ts) => {
    await dbUpdateLastStudied(edPubkey, ts)
    set((state) => ({
      friends: state.friends.map((f) =>
        f.ed_pubkey_hex === edPubkey ? { ...f, last_studied_with: ts } : f
      ),
    }))
  },
}))
