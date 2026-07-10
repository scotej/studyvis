import { beforeEach, describe, expect, test } from 'vitest'

import type { ValidInvite } from '@/features/friends'
import { pendingInviteKey, usePendingInvitesStore } from '@/features/friends'

const NOW = 1_700_000_000_000

function invite(sender: string, topic: string, expiresAt: number): ValidInvite {
  return {
    from_ed_pubkey: sender,
    payload: {
      session_topic: topic,
      session_password: 'pw',
      our_display_name: 'Alex',
      expires_at: expiresAt,
      sig: '00',
    },
  }
}

describe('pendingInvitesStore (#47 B1)', () => {
  beforeEach(() => {
    usePendingInvitesStore.getState().clear()
  })

  test('add holds an invite until its expiry', () => {
    usePendingInvitesStore.getState().add(invite('a', 't1', NOW + 60_000), NOW)
    expect(usePendingInvitesStore.getState().pending).toHaveLength(1)
  })

  test('a re-sent invite for the same sender+session replaces, not stacks', () => {
    const store = usePendingInvitesStore.getState()
    store.add(invite('a', 't1', NOW + 60_000), NOW)
    store.add(invite('a', 't1', NOW + 120_000), NOW + 1_000)
    const pending = usePendingInvitesStore.getState().pending
    expect(pending).toHaveLength(1)
    expect(pending[0].invite.payload.expires_at).toBe(NOW + 120_000)
  })

  test('distinct senders and sessions coexist', () => {
    const store = usePendingInvitesStore.getState()
    store.add(invite('a', 't1', NOW + 60_000), NOW)
    store.add(invite('b', 't2', NOW + 60_000), NOW)
    expect(usePendingInvitesStore.getState().pending).toHaveLength(2)
  })

  test('prune drops only expired entries', () => {
    const store = usePendingInvitesStore.getState()
    store.add(invite('a', 't1', NOW + 10_000), NOW)
    store.add(invite('b', 't2', NOW + 120_000), NOW)
    usePendingInvitesStore.getState().prune(NOW + 30_000)
    const pending = usePendingInvitesStore.getState().pending
    expect(pending).toHaveLength(1)
    expect(pending[0].key).toBe(pendingInviteKey(invite('b', 't2', 0)))
  })

  test('remove deletes by key; unknown keys are a no-op', () => {
    const store = usePendingInvitesStore.getState()
    const inv = invite('a', 't1', NOW + 60_000)
    store.add(inv, NOW)
    usePendingInvitesStore.getState().remove('nope:nope')
    expect(usePendingInvitesStore.getState().pending).toHaveLength(1)
    usePendingInvitesStore.getState().remove(pendingInviteKey(inv))
    expect(usePendingInvitesStore.getState().pending).toHaveLength(0)
  })
})
