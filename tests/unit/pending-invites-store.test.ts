import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import type { ValidInvite } from '@/features/friends'
import { serializePayloadForSig } from '@/features/friends/envelope'
import {
  __flushPendingInvitePersistence,
  __resetPendingInviteStoreDeps,
  __setPendingInviteStoreDeps,
  pendingInviteKey,
  usePendingInvitesStore,
  type PendingInviteStoreLike,
} from '@/features/friends/pendingInvitesStore'
import { generateIdentity, signMessage } from '@/lib/crypto/identity'
import { bytesToHex } from '@/lib/encoding'

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

function signedInvite(topic: string, expiresAt: number): ValidInvite {
  const identity = generateIdentity()
  const core = {
    session_topic: topic,
    session_password: 'pw',
    our_display_name: 'Alex',
    expires_at: expiresAt,
  }
  return {
    from_ed_pubkey: bytesToHex(identity.edPub),
    payload: {
      ...core,
      sig: bytesToHex(signMessage(identity.edPriv, serializePayloadForSig(core))),
    },
  }
}

class FakeStore implements PendingInviteStoreLike {
  readonly values = new Map<string, unknown>()
  saves = 0

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined
  }

  async set(key: string, value: unknown): Promise<void> {
    this.values.set(key, value)
  }

  async delete(key: string): Promise<boolean> {
    return this.values.delete(key)
  }

  async save(): Promise<void> {
    this.saves += 1
  }
}

function persisted(entryInvite: ValidInvite, receivedAt = NOW) {
  return {
    key: pendingInviteKey(entryInvite),
    invite: entryInvite,
    receivedAt,
  }
}

describe('pendingInvitesStore (#182)', () => {
  beforeEach(() => {
    usePendingInvitesStore.getState().deactivate()
    __resetPendingInviteStoreDeps()
  })

  afterEach(() => {
    usePendingInvitesStore.getState().deactivate()
    __resetPendingInviteStoreDeps()
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

  test('persists and restores a signed invite for the active identity', async () => {
    const fake = new FakeStore()
    __setPendingInviteStoreDeps({ storeFactory: () => fake })
    const inv = signedInvite('topic-1', NOW + 120_000)

    await usePendingInvitesStore
      .getState()
      .hydrate('identity-a', new Set([inv.from_ed_pubkey]), NOW)
    usePendingInvitesStore.getState().add(inv, NOW)
    await __flushPendingInvitePersistence()

    const snapshot = fake.values.get('identity:identity-a')
    expect(snapshot).toMatchObject({ v: 1 })

    usePendingInvitesStore.getState().deactivate()
    await usePendingInvitesStore
      .getState()
      .hydrate('identity-a', new Set([inv.from_ed_pubkey]), NOW + 1_000)

    expect(usePendingInvitesStore.getState().pending).toEqual([
      persisted(inv, NOW),
    ])
  })

  test('drops expired, tampered, and no-longer-friend records on restore', async () => {
    const fake = new FakeStore()
    __setPendingInviteStoreDeps({ storeFactory: () => fake })
    const valid = signedInvite('valid', NOW + 120_000)
    const expired = signedInvite('expired', NOW - 1)
    const tampered = signedInvite('tampered', NOW + 120_000)
    tampered.payload.session_password = 'changed-after-signing'
    const removedFriend = signedInvite('removed', NOW + 120_000)
    fake.values.set('identity:identity-a', {
      v: 1,
      entries: [
        persisted(valid),
        persisted(expired, NOW - 60_000),
        persisted(tampered),
        persisted(removedFriend),
      ],
    })

    await usePendingInvitesStore
      .getState()
      .hydrate('identity-a', new Set([valid.from_ed_pubkey]), NOW)

    expect(usePendingInvitesStore.getState().pending).toEqual([
      persisted(valid),
    ])
  })

  test('keeps an invite delivered while disk hydration is in flight', async () => {
    const restored = signedInvite('restored', NOW + 120_000)
    const live = signedInvite('live', NOW + 120_000)
    let releaseRead: (() => void) | undefined
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve
    })
    const fake = new FakeStore()
    fake.values.set('identity:identity-a', {
      v: 1,
      entries: [persisted(restored)],
    })
    fake.get = async <T>(key: string) => {
      await readGate
      return fake.values.get(key) as T | undefined
    }
    __setPendingInviteStoreDeps({ storeFactory: () => fake })

    const hydration = usePendingInvitesStore.getState().hydrate(
      'identity-a',
      new Set([restored.from_ed_pubkey, live.from_ed_pubkey]),
      NOW
    )
    usePendingInvitesStore.getState().add(live, NOW + 1)
    releaseRead?.()
    await hydration

    expect(
      usePendingInvitesStore.getState().pending.map((entry) => entry.key)
    ).toEqual([pendingInviteKey(restored), pendingInviteKey(live)])
  })
})
