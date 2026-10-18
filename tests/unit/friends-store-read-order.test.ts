import { beforeEach, describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({
  listFriends: vi.fn(),
  addFriend: vi.fn(),
  removeFriend: vi.fn(),
  updateLastStudied: vi.fn(),
}))
vi.mock('@/lib/db/friends', () => db)
vi.mock('@/lib/log', () => ({
  logger: { child: () => ({ error: vi.fn() }) },
}))

import type { Friend } from '@/lib/db/friends'
import { useFriendsStore } from '@/stores/friendsStore'

const alice: Friend = {
  ed_pubkey_hex: 'alice',
  x_pubkey_hex: 'alice-x',
  display_name: 'Alice',
  paired_at: 10,
  last_studied_with: null,
}
const bob = { ...alice, ed_pubkey_hex: 'bob', display_name: 'Bob' }

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

beforeEach(() => {
  vi.resetAllMocks()
  db.addFriend.mockResolvedValue(undefined)
  db.removeFriend.mockResolvedValue(undefined)
  db.updateLastStudied.mockResolvedValue(undefined)
  useFriendsStore.setState({ friends: [alice], status: 'ready', error: null })
})

describe('roster read ownership (#384)', () => {
  it('re-reads a snapshot captured before a completed removal', async () => {
    const stale = deferred<Friend[]>()
    const fresh = deferred<Friend[]>()
    db.listFriends
      .mockReturnValueOnce(stale.promise)
      .mockReturnValueOnce(fresh.promise)
    const load = useFriendsStore.getState().load()
    await useFriendsStore.getState().remove('alice')
    expect(useFriendsStore.getState().friends).toEqual([])
    stale.resolve([alice])
    await vi.waitFor(() => expect(db.listFriends).toHaveBeenCalledTimes(2))
    expect(useFriendsStore.getState().friends).toEqual([])
    fresh.resolve([])
    await load
    expect(useFriendsStore.getState().friends).toEqual([])
    expect(useFriendsStore.getState().status).toBe('ready')
  })

  it('older loads await the newest read rather than return early or overwrite it', async () => {
    const older = deferred<Friend[]>()
    const newer = deferred<Friend[]>()
    db.listFriends
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise)
    let done = false
    const first = useFriendsStore
      .getState()
      .load()
      .then(() => {
        done = true
      })
    const second = useFriendsStore.getState().load()
    older.resolve([alice])
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(done).toBe(false)
    newer.resolve([bob])
    await Promise.all([first, second])
    expect(useFriendsStore.getState().friends).toEqual([bob])
  })

  it('an old load cannot overwrite newer imported contact keys/name', async () => {
    const stale = deferred<Friend[]>()
    const updated = { ...alice, x_pubkey_hex: 'new-x', display_name: 'Updated' }
    db.listFriends
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValueOnce([updated])
    const load = useFriendsStore.getState().load()
    await useFriendsStore.getState().add('alice', 'new-x', 'Updated', 20)
    stale.resolve([alice])
    await load
    expect(useFriendsStore.getState().friends).toEqual([updated])
  })

  for (const refresh of ['markStudied', 'markStudiedAt'] as const) {
    it(`${refresh} cannot resurrect a removed row`, async () => {
      const stale = deferred<Friend[]>()
      db.listFriends
        .mockReturnValueOnce(stale.promise)
        .mockResolvedValueOnce([])
      const pending =
        refresh === 'markStudied'
          ? useFriendsStore.getState().markStudied(['alice'], 20)
          : useFriendsStore
              .getState()
              .markStudiedAt([{ edPubkey: 'alice', ts: 20 }])
      await vi.waitFor(() => expect(db.listFriends).toHaveBeenCalledTimes(1))
      await useFriendsStore.getState().remove('alice')
      stale.resolve([alice])
      await pending
      expect(useFriendsStore.getState().friends).toEqual([])
    })
  }

  it('post-add reload retries a snapshot captured before a concurrent removal', async () => {
    const stale = deferred<Friend[]>()
    db.listFriends
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValueOnce([bob])
    const add = useFriendsStore.getState().add('bob', 'bob-x', 'Bob', 20)
    await vi.waitFor(() => expect(db.listFriends).toHaveBeenCalledTimes(1))
    await useFriendsStore.getState().remove('alice')
    stale.resolve([alice, bob])
    await add
    expect(useFriendsStore.getState().friends).toEqual([bob])
  })

  it('a stale rejection cannot replace a newer successful load with an error', async () => {
    const stale = deferred<Friend[]>()
    db.listFriends
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValueOnce([bob])
    const older = useFriendsStore.getState().load()
    await useFriendsStore.getState().load()
    stale.reject(new Error('older read failed'))
    await older
    expect(useFriendsStore.getState().friends).toEqual([bob])
    expect(useFriendsStore.getState().status).toBe('ready')
    expect(useFriendsStore.getState().error).toBe(null)
  })
})
