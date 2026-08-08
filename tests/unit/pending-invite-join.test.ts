import { describe, expect, test, vi } from 'vitest'

import type { ValidInvite } from '@/features/friends'
import { joinAndRemovePendingInvite } from '@/routes/pendingInviteJoin'

const KEY = 'sender:session-topic'
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
    const removePendingInvite = vi.fn((key: string) => pending.delete(key))

    expect(() =>
      joinAndRemovePendingInvite(INVITE, KEY, {
        joinSession: () => {
          throw new Error('join failed')
        },
        removePendingInvite,
      })
    ).toThrow('join failed')

    expect(removePendingInvite).not.toHaveBeenCalled()
    expect(pending.has(KEY)).toBe(true)
  })

  test('removes the invite only after joining succeeds', () => {
    const pending = new Set([KEY])
    const calls: string[] = []

    joinAndRemovePendingInvite(INVITE, KEY, {
      joinSession: (topic, password) => {
        expect(topic).toBe(INVITE.payload.session_topic)
        expect(password).toBe(INVITE.payload.session_password)
        expect(pending.has(KEY)).toBe(true)
        calls.push('join')
      },
      removePendingInvite: (key) => {
        calls.push('remove')
        pending.delete(key)
      },
    })

    expect(calls).toEqual(['join', 'remove'])
    expect(pending.has(KEY)).toBe(false)
  })
})
