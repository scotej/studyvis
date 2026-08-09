import { describe, expect, test, vi } from 'vitest'

import type { ValidInvite } from '@/features/friends'
import { joinAndRemovePendingInvite } from '@/routes/pendingInviteJoin'

const KEY = 'sender:session-topic'
const IDENTITY = 'recipient'
const INVITE: ValidInvite = {
  from_ed_pubkey: 'sender',
  payload: {
    session_topic: 'session-topic',
    session_password: 'session-password',
    our_display_name: 'Friend',
    expires_at: 1,
    sig: 'signature',
  },
}

describe('joinAndRemovePendingInvite', () => {
  test('preserves the invite when joining throws', () => {
    const pending = new Set([KEY])
    const removePendingInviteIfCurrent = vi.fn(
      (_identity: string, key: string) => pending.delete(key)
    )

    expect(() =>
      joinAndRemovePendingInvite(INVITE, KEY, IDENTITY, {
        joinSession: () => {
          throw new Error('join failed')
        },
        removePendingInviteIfCurrent,
      })
    ).toThrow('join failed')

    expect(removePendingInviteIfCurrent).not.toHaveBeenCalled()
    expect(pending.has(KEY)).toBe(true)
  })

  test('keeps the invite until the original inviter completes authentication', () => {
    const pending = new Set([KEY])
    const calls: string[] = []
    let onPeerAuthenticated: ((edPubkeyHex: string) => void) | undefined

    const removePendingInviteIfCurrent = vi.fn(
      (identityEdPubkeyHex: string, key: string, invite: ValidInvite) => {
        expect(identityEdPubkeyHex).toBe(IDENTITY)
        expect(key).toBe(KEY)
        expect(invite).toBe(INVITE)
        calls.push('remove')
        pending.delete(key)
      }
    )

    joinAndRemovePendingInvite(INVITE, KEY, IDENTITY, {
      joinSession: (topic, password, options) => {
        expect(topic).toBe(INVITE.payload.session_topic)
        expect(password).toBe(INVITE.payload.session_password)
        expect(pending.has(KEY)).toBe(true)
        calls.push('join')
        onPeerAuthenticated = options.onPeerAuthenticated
      },
      removePendingInviteIfCurrent,
    })

    expect(calls).toEqual(['join'])
    expect(pending.has(KEY)).toBe(true)

    onPeerAuthenticated?.('another-authenticated-peer')
    expect(calls).toEqual(['join'])
    expect(pending.has(KEY)).toBe(true)
    expect(removePendingInviteIfCurrent).not.toHaveBeenCalled()

    // Signed hellos accept either hex case while inbox storage canonicalizes
    // the invite sender to lowercase. They still identify the same key.
    onPeerAuthenticated?.(INVITE.from_ed_pubkey.toUpperCase())
    onPeerAuthenticated?.(INVITE.from_ed_pubkey)
    expect(calls).toEqual(['join', 'remove'])
    expect(pending.has(KEY)).toBe(false)
    expect(removePendingInviteIfCurrent).toHaveBeenCalledTimes(1)
  })
})
