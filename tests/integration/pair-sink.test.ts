import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}))

import { useFriendsStore } from '@/stores/friendsStore'
import type { PairedFriend } from '@/features/friends/pair'

beforeEach(() => {
  invokeMock.mockReset()
  useFriendsStore.setState({ friends: [], status: 'idle', error: null })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useFriendsStore.add is the only sink, mapping to V1-P4 schema', () => {
  test('pairing result columns map (ed_pubkey, x_pubkey, display_name, paired_at)', async () => {
    const friend: PairedFriend = {
      edPubkey: 'ed-pub-hex',
      xPubkey: 'x-pub-hex',
      name: 'Alice',
    }
    const ts = 1_700_000_000_000

    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'friends_add') return undefined
      if (cmd === 'friends_list')
        return [
          {
            ed_pubkey_hex: friend.edPubkey,
            x_pubkey_hex: friend.xPubkey,
            display_name: friend.name,
            paired_at: ts,
            last_studied_with: null,
          },
        ]
      throw new Error(`unexpected invoke: ${cmd}`)
    })

    await useFriendsStore
      .getState()
      .add(friend.edPubkey, friend.xPubkey, friend.name, ts)

    const addCall = invokeMock.mock.calls.find(
      ([cmd]) => cmd === 'friends_add'
    )
    expect(addCall).toBeDefined()
    expect(addCall?.[1]).toEqual({
      edPubkey: friend.edPubkey,
      xPubkey: friend.xPubkey,
      name: friend.name,
      ts,
    })

    const row = useFriendsStore.getState().friends[0]
    expect(row).toMatchObject({
      ed_pubkey_hex: friend.edPubkey,
      x_pubkey_hex: friend.xPubkey,
      display_name: friend.name,
      paired_at: ts,
    })
  })
})
