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
  refresh: () => Promise<void>
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
    await refresh()
  } catch {
    // best-effort: leave list as-is; next mount/load will resync.
  }
}

export const useFriendsStore = create<FriendsState>((set) => {
  let mutationRevision = 0
  let readGeneration = 0
  let loadGeneration = 0
  let latestRead: Promise<void> = Promise.resolve()

  // #384 — a snapshot may predate a completed write even when its IPC result
  // arrives later. Retry across mutations; superseded readers await the latest
  // read so their callers never mistake an early no-op for a completed resync.
  const refresh = (): Promise<void> => {
    const generation = ++readGeneration
    const read = async () => {
      for (;;) {
        const revision = mutationRevision
        let friends: Friend[]
        try {
          friends = await listFriends()
        } catch (err) {
          if (generation !== readGeneration) return latestRead
          throw err
        }
        if (generation !== readGeneration) return latestRead
        if (revision !== mutationRevision) continue
        set({ friends })
        return
      }
    }
    latestRead = read()
    return latestRead
  }

  const refreshAfterMutation = () => {
    mutationRevision++
    return refresh()
  }

  return {
    friends: [],
    status: 'idle',
    error: null,

    load: async () => {
      const generation = ++loadGeneration
      set({ status: 'loading', error: null })
      try {
        await refresh()
        if (generation === loadGeneration) set({ status: 'ready', error: null })
      } catch (err) {
        // Tauri rejects with a plain string — storing it verbatim would hand
        // raw rusqlite text to whichever surface renders `error` next. Keep
        // the raw value in the log; the store carries friendly copy.
        log.error('list.failed', { cmd: 'friends_list', err })
        if (generation === loadGeneration) {
          set({ status: 'error', error: strings.friends.loadError })
        }
      }
    },

    add: async (edPubkey, xPubkey, name, ts) => {
      await dbAddFriend(edPubkey, xPubkey, name, ts)
      await refreshAfterMutation()
    },

    remove: async (edPubkey) => {
      await dbRemoveFriend(edPubkey)
      mutationRevision++
      set((state) => ({
        friends: state.friends.filter((f) => f.ed_pubkey_hex !== edPubkey),
      }))
    },

    markStudied: async (edPubkeys, ts) =>
      persistStudiedAt(
        edPubkeys.map((edPubkey) => ({ edPubkey, ts })),
        refreshAfterMutation
      ),
    markStudiedAt: async (entries) =>
      persistStudiedAt(entries, refreshAfterMutation),
  }
})
