import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import type { ValidInvite } from '@/features/friends'
import {
  INVITE_TTL_MS,
  serializePayloadForSig,
} from '@/features/friends/envelope'
import {
  __flushPendingInvitePersistence,
  __resetPendingInviteStoreDeps,
  __setPendingInviteStoreDeps,
  PENDING_INVITES_STORE_KEY,
  pendingInviteKey,
  usePendingInvitesStore,
  type PendingInviteStoreLike,
} from '@/features/friends/pendingInvitesStore'
import { generateIdentity, signMessage } from '@/lib/crypto/identity'
import { bytesToHex } from '@/lib/encoding'

const NOW = 1_700_000_000_000
const IDENTITY_A = 'aa'.repeat(32)
const IDENTITY_B = 'bb'.repeat(32)

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

type TestIdentity = ReturnType<typeof generateIdentity>

function signedInvite(
  topic: string,
  expiresAt: number,
  options: {
    identity?: TestIdentity
    sessionPassword?: string
    displayName?: string
  } = {}
): ValidInvite {
  const identity = options.identity ?? generateIdentity()
  const core = {
    session_topic: topic,
    session_password: options.sessionPassword ?? 'pw',
    our_display_name: options.displayName ?? 'Alex',
    expires_at: expiresAt,
  }
  return {
    from_ed_pubkey: bytesToHex(identity.edPub),
    payload: {
      ...core,
      sig: bytesToHex(
        signMessage(identity.edPriv, serializePayloadForSig(core))
      ),
    },
  }
}

class FakeStore implements PendingInviteStoreLike {
  readonly values = new Map<string, unknown>()
  readonly gets: string[] = []
  readonly sets: string[] = []
  readonly deletes: string[] = []
  saves = 0
  getError: unknown = null
  setError: unknown = null
  deleteError: unknown = null
  saveError: unknown = null

  async get<T>(key: string): Promise<T | undefined> {
    this.gets.push(key)
    if (this.getError) throw this.getError
    return this.values.get(key) as T | undefined
  }

  async set(key: string, value: unknown): Promise<void> {
    this.sets.push(key)
    if (this.setError) throw this.setError
    this.values.set(key, value)
  }

  async delete(key: string): Promise<boolean> {
    this.deletes.push(key)
    if (this.deleteError) throw this.deleteError
    return this.values.delete(key)
  }

  async save(): Promise<void> {
    if (this.saveError) throw this.saveError
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

function snapshot(
  identityEdPubkeyHex: string,
  entries: unknown[]
): { v: 2; identityEdPubkeyHex: string; entries: unknown[] } {
  return {
    v: 2,
    identityEdPubkeyHex: identityEdPubkeyHex.toLowerCase(),
    entries,
  }
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function activate(identity = IDENTITY_A) {
  usePendingInvitesStore.getState().activateIdentity(identity)
}

function add(entryInvite: ValidInvite, now = NOW, identity = IDENTITY_A) {
  usePendingInvitesStore.getState().add(identity, entryInvite, now)
}

function storedEntries(fake: FakeStore, identity = IDENTITY_A): unknown[] {
  const stored = fake.values.get(PENDING_INVITES_STORE_KEY) as
    | {
        v: number
        identityEdPubkeyHex: string
        entries: unknown[]
      }
    | undefined
  return stored?.identityEdPubkeyHex === identity.toLowerCase()
    ? stored.entries
    : []
}

describe('pendingInvitesStore (#182)', () => {
  beforeEach(async () => {
    await __flushPendingInvitePersistence()
    const identity = usePendingInvitesStore.getState().identityEdPubkeyHex
    if (identity) usePendingInvitesStore.getState().deactivateExpected(identity)
    __resetPendingInviteStoreDeps()
  })

  afterEach(async () => {
    await __flushPendingInvitePersistence()
    const identity = usePendingInvitesStore.getState().identityEdPubkeyHex
    if (identity) usePendingInvitesStore.getState().deactivateExpected(identity)
    __resetPendingInviteStoreDeps()
    vi.useRealTimers()
  })

  test('add holds an invite until its expiry', () => {
    activate()
    add(invite('a', 't1', NOW + 60_000))
    expect(usePendingInvitesStore.getState().pending).toHaveLength(1)
  })

  test('a re-sent invite for the same sender+session replaces, not stacks', () => {
    activate()
    add(invite('a', 't1', NOW + 60_000))
    add(invite('a', 't1', NOW + 120_000), NOW + 1_000)
    const pending = usePendingInvitesStore.getState().pending
    expect(pending).toHaveLength(1)
    expect(pending[0].invite.payload.expires_at).toBe(NOW + 120_000)
  })

  test('distinct senders and sessions coexist', () => {
    activate()
    add(invite('a', 't1', NOW + 60_000))
    add(invite('b', 't2', NOW + 60_000))
    expect(usePendingInvitesStore.getState().pending).toHaveLength(2)
  })

  test('prune drops only expired entries', () => {
    activate()
    add(invite('a', 't1', NOW + 10_000))
    add(invite('b', 't2', NOW + 120_000))
    usePendingInvitesStore.getState().prune(NOW + 30_000)
    const pending = usePendingInvitesStore.getState().pending
    expect(pending).toHaveLength(1)
    expect(pending[0].key).toBe(pendingInviteKey(invite('b', 't2', 0)))
  })

  test('remove deletes by key; unknown keys are a no-op', () => {
    activate()
    const inv = invite('a', 't1', NOW + 60_000)
    add(inv)
    usePendingInvitesStore.getState().remove('nope:nope')
    expect(usePendingInvitesStore.getState().pending).toHaveLength(1)
    usePendingInvitesStore.getState().remove(pendingInviteKey(inv))
    expect(usePendingInvitesStore.getState().pending).toHaveLength(0)
  })

  test('persists and restores a signed invite for the active identity', async () => {
    const fake = new FakeStore()
    __setPendingInviteStoreDeps({ storeFactory: () => fake })
    const inv = signedInvite('topic-1', NOW + 120_000)

    activate()
    await usePendingInvitesStore
      .getState()
      .reconcile(IDENTITY_A, new Set([inv.from_ed_pubkey]), NOW)
    add(inv)
    await __flushPendingInvitePersistence()

    const stored = fake.values.get(PENDING_INVITES_STORE_KEY)
    expect(stored).toMatchObject({
      v: 2,
      identityEdPubkeyHex: IDENTITY_A,
    })

    usePendingInvitesStore.getState().deactivateExpected(IDENTITY_A)
    activate()
    await usePendingInvitesStore
      .getState()
      .reconcile(IDENTITY_A, new Set([inv.from_ed_pubkey]), NOW + 1_000)

    expect(usePendingInvitesStore.getState().pending).toEqual([
      persisted(inv, NOW),
    ])
  })

  test('restores an invite persisted from uppercase wire hex', async () => {
    const fake = new FakeStore()
    const canonical = signedInvite('uppercase-wire', NOW + 120_000)
    const uppercase: ValidInvite = {
      from_ed_pubkey: canonical.from_ed_pubkey.toUpperCase(),
      payload: {
        ...canonical.payload,
        sig: canonical.payload.sig.toUpperCase(),
      },
    }
    __setPendingInviteStoreDeps({ storeFactory: () => fake })

    activate()
    await usePendingInvitesStore
      .getState()
      .reconcile(IDENTITY_A, new Set([canonical.from_ed_pubkey]), NOW)
    add(uppercase)
    await __flushPendingInvitePersistence()

    expect(storedEntries(fake)).toEqual([
      {
        key: pendingInviteKey(canonical),
        invite: uppercase,
        receivedAt: NOW,
      },
    ])

    usePendingInvitesStore.getState().deactivateExpected(IDENTITY_A)
    activate()
    await usePendingInvitesStore
      .getState()
      .reconcile(IDENTITY_A, new Set([canonical.from_ed_pubkey]), NOW + 1)

    expect(usePendingInvitesStore.getState().pending).toEqual([
      persisted(canonical),
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
    fake.values.set(
      PENDING_INVITES_STORE_KEY,
      snapshot(IDENTITY_A, [
        persisted(valid),
        persisted(expired, NOW - 60_000),
        persisted(tampered),
        persisted(removedFriend),
      ])
    )

    activate()
    await usePendingInvitesStore
      .getState()
      .reconcile(IDENTITY_A, new Set([valid.from_ed_pubkey]), NOW)

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
    const diskSnapshot = snapshot(IDENTITY_A, [persisted(restored)])
    fake.values.set(PENDING_INVITES_STORE_KEY, diskSnapshot)
    fake.get = async <T>(key: string) => {
      const value = fake.values.get(key) as T | undefined
      await readGate
      return value
    }
    __setPendingInviteStoreDeps({ storeFactory: () => fake })

    activate()
    const hydration = usePendingInvitesStore
      .getState()
      .reconcile(
        IDENTITY_A,
        new Set([restored.from_ed_pubkey, live.from_ed_pubkey]),
        NOW
      )
    add(live, NOW + 1)
    releaseRead?.()
    await hydration

    expect(
      usePendingInvitesStore.getState().pending.map((entry) => entry.key)
    ).toEqual([pendingInviteKey(restored), pendingInviteKey(live)])
  })

  test('merges an invite delivered after activation but before reconciliation', async () => {
    const fake = new FakeStore()
    const restored = signedInvite('restored-before-reconcile', NOW + 120_000)
    const live = signedInvite('live-before-reconcile', NOW + 120_000)
    fake.values.set(
      PENDING_INVITES_STORE_KEY,
      snapshot(IDENTITY_A, [persisted(restored)])
    )
    __setPendingInviteStoreDeps({ storeFactory: () => fake })

    activate()
    expect(
      usePendingInvitesStore.getState().add(IDENTITY_A, live, NOW + 1)
    ).toBe(true)
    await usePendingInvitesStore
      .getState()
      .reconcile(
        IDENTITY_A,
        new Set([restored.from_ed_pubkey, live.from_ed_pubkey]),
        NOW + 2
      )

    expect(
      usePendingInvitesStore.getState().pending.map((entry) => entry.key)
    ).toEqual([pendingInviteKey(restored), pendingInviteKey(live)])
  })

  test('rejects additions outside the active identity scope', () => {
    const inv = signedInvite('identity-bound', NOW + 120_000)

    expect(usePendingInvitesStore.getState().add(IDENTITY_A, inv, NOW)).toBe(
      false
    )
    activate()
    expect(usePendingInvitesStore.getState().add(IDENTITY_B, inv, NOW)).toBe(
      false
    )
    expect(usePendingInvitesStore.getState().add(IDENTITY_A, inv, NOW)).toBe(
      true
    )
    expect(usePendingInvitesStore.getState().pending).toEqual([persisted(inv)])
  })

  test('a stale deactivation cannot clear a newer identity scope', () => {
    const inv = signedInvite('identity-b', NOW + 120_000)
    activate(IDENTITY_A)
    activate(IDENTITY_B)
    add(inv, NOW, IDENTITY_B)

    usePendingInvitesStore.getState().deactivateExpected(IDENTITY_A)
    expect(usePendingInvitesStore.getState()).toMatchObject({
      identityEdPubkeyHex: IDENTITY_B,
      pending: [persisted(inv)],
    })

    usePendingInvitesStore.getState().deactivateExpected(IDENTITY_B)
    expect(usePendingInvitesStore.getState()).toMatchObject({
      identityEdPubkeyHex: null,
      pending: [],
      status: 'idle',
    })
  })

  test('live delivery wins a same-key collision with restored data', async () => {
    const identity = generateIdentity()
    const restored = signedInvite('same-topic', NOW + 120_000, {
      identity,
      sessionPassword: 'restored-password',
    })
    const live = signedInvite('same-topic', NOW + 180_000, {
      identity,
      sessionPassword: 'live-password',
    })
    const fake = new FakeStore()
    fake.values.set(
      PENDING_INVITES_STORE_KEY,
      snapshot(IDENTITY_A, [persisted(restored, NOW + 500)])
    )
    __setPendingInviteStoreDeps({ storeFactory: () => fake })

    activate()
    add(live, NOW)
    await usePendingInvitesStore
      .getState()
      .reconcile(IDENTITY_A, new Set([live.from_ed_pubkey]), NOW + 1_000)

    expect(usePendingInvitesStore.getState().pending).toEqual([persisted(live)])
  })

  test('a dismissal during a delayed read cannot resurrect from disk', async () => {
    const inv = signedInvite('dismiss-during-read', NOW + 120_000)
    const read = deferred()
    const fake = new FakeStore()
    const diskSnapshot = snapshot(IDENTITY_A, [persisted(inv)])
    fake.values.set(PENDING_INVITES_STORE_KEY, diskSnapshot)
    fake.get = async <T>(key: string) => {
      const value = fake.values.get(key) as T | undefined
      await read.promise
      return value
    }
    __setPendingInviteStoreDeps({ storeFactory: () => fake })

    activate()
    add(inv)
    const reconciliation = usePendingInvitesStore
      .getState()
      .reconcile(IDENTITY_A, new Set([inv.from_ed_pubkey]), NOW)
    usePendingInvitesStore.getState().remove(pendingInviteKey(inv))
    read.resolve()
    await reconciliation
    await __flushPendingInvitePersistence()

    expect(usePendingInvitesStore.getState().pending).toEqual([])
    expect(fake.values.has(PENDING_INVITES_STORE_KEY)).toBe(false)
  })

  test('dismissal suppresses the exact disk retry but permits a newly signed same-key invite', async () => {
    const identity = generateIdentity()
    const dismissed = signedInvite('retried-topic', NOW + 120_000, {
      identity,
      sessionPassword: 'dismissed-password',
    })
    const fresh = signedInvite('retried-topic', NOW + 180_000, {
      identity,
      sessionPassword: 'fresh-password',
    })
    const read = deferred()
    const fake = new FakeStore()
    const dismissedSnapshot = snapshot(IDENTITY_A, [persisted(dismissed)])
    fake.values.set(PENDING_INVITES_STORE_KEY, dismissedSnapshot)
    fake.get = async <T>(key: string) => {
      const value = fake.values.get(key) as T | undefined
      await read.promise
      return value
    }
    __setPendingInviteStoreDeps({ storeFactory: () => fake })

    activate()
    add(dismissed)
    const reconciliation = usePendingInvitesStore
      .getState()
      .reconcile(IDENTITY_A, new Set([dismissed.from_ed_pubkey]), NOW)
    usePendingInvitesStore.getState().remove(pendingInviteKey(dismissed))
    read.resolve()
    await reconciliation
    await __flushPendingInvitePersistence()
    expect(usePendingInvitesStore.getState().pending).toEqual([])

    fake.get = async <T>(key: string) => fake.values.get(key) as T | undefined
    fake.values.set(PENDING_INVITES_STORE_KEY, dismissedSnapshot)
    await usePendingInvitesStore
      .getState()
      .reconcile(IDENTITY_A, new Set([dismissed.from_ed_pubkey]), NOW + 1)
    await __flushPendingInvitePersistence()
    expect(usePendingInvitesStore.getState().pending).toEqual([])
    expect(fake.values.has(PENDING_INVITES_STORE_KEY)).toBe(false)

    expect(
      usePendingInvitesStore.getState().add(IDENTITY_A, fresh, NOW + 2)
    ).toBe(true)
    await __flushPendingInvitePersistence()
    expect(usePendingInvitesStore.getState().pending).toEqual([
      persisted(fresh, NOW + 2),
    ])
    expect(storedEntries(fake)).toEqual([persisted(fresh, NOW + 2)])
  })

  test('exact duplicate delivery is suppressed but a new signed payload replaces it', () => {
    const identity = generateIdentity()
    const first = signedInvite('duplicate-topic', NOW + 120_000, {
      identity,
      sessionPassword: 'first-password',
    })
    const replacement = signedInvite('duplicate-topic', NOW + 180_000, {
      identity,
      sessionPassword: 'replacement-password',
    })
    activate()

    expect(usePendingInvitesStore.getState().add(IDENTITY_A, first, NOW)).toBe(
      true
    )
    expect(
      usePendingInvitesStore.getState().add(IDENTITY_A, first, NOW + 1)
    ).toBe(false)
    expect(usePendingInvitesStore.getState().pending).toEqual([
      persisted(first),
    ])

    expect(
      usePendingInvitesStore.getState().add(IDENTITY_A, replacement, NOW + 2)
    ).toBe(true)
    expect(usePendingInvitesStore.getState().pending).toEqual([
      persisted(replacement, NOW + 2),
    ])
  })

  test('a successful identity switch removes the inactive identity snapshot', async () => {
    const fake = new FakeStore()
    const inviteA = signedInvite('only-a', NOW + 120_000)
    const inviteB = signedInvite('only-b', NOW + 120_000)
    __setPendingInviteStoreDeps({ storeFactory: () => fake })

    activate(IDENTITY_A)
    await usePendingInvitesStore
      .getState()
      .reconcile(IDENTITY_A, new Set([inviteA.from_ed_pubkey]), NOW)
    add(inviteA, NOW, IDENTITY_A)
    await __flushPendingInvitePersistence()

    activate(IDENTITY_B)
    await usePendingInvitesStore
      .getState()
      .reconcile(IDENTITY_B, new Set([inviteB.from_ed_pubkey]), NOW)
    add(inviteB, NOW, IDENTITY_B)
    await __flushPendingInvitePersistence()

    expect(storedEntries(fake, IDENTITY_A)).toEqual([])
    expect(storedEntries(fake, IDENTITY_B)).toEqual([persisted(inviteB)])
    expect(fake.values.get(PENDING_INVITES_STORE_KEY)).toMatchObject({
      v: 2,
      identityEdPubkeyHex: IDENTITY_B,
    })

    usePendingInvitesStore.getState().deactivateExpected(IDENTITY_B)
    activate(IDENTITY_A)
    await usePendingInvitesStore
      .getState()
      .reconcile(IDENTITY_A, new Set([inviteA.from_ed_pubkey]), NOW + 1)
    await __flushPendingInvitePersistence()
    expect(usePendingInvitesStore.getState().pending).toEqual([])
    expect(fake.values.has(PENDING_INVITES_STORE_KEY)).toBe(false)
  })

  test('ignores an old identity read that completes after a new identity', async () => {
    const inviteA = signedInvite('stale-a', NOW + 120_000)
    const inviteB = signedInvite('current-b', NOW + 120_000)
    const readA = deferred()
    const fake = new FakeStore()
    const snapshotA = snapshot(IDENTITY_A, [persisted(inviteA)])
    const snapshotB = snapshot(IDENTITY_B, [persisted(inviteB)])
    fake.values.set(PENDING_INVITES_STORE_KEY, snapshotB)
    let reads = 0
    fake.get = async <T>() => {
      reads += 1
      if (reads === 1) {
        await readA.promise
        return snapshotA as T
      }
      return snapshotB as T
    }
    __setPendingInviteStoreDeps({ storeFactory: () => fake })

    activate(IDENTITY_A)
    const stale = usePendingInvitesStore
      .getState()
      .reconcile(IDENTITY_A, new Set([inviteA.from_ed_pubkey]), NOW)
    activate(IDENTITY_B)
    const current = usePendingInvitesStore
      .getState()
      .reconcile(IDENTITY_B, new Set([inviteB.from_ed_pubkey]), NOW)
    readA.resolve()
    await Promise.all([stale, current])

    expect(usePendingInvitesStore.getState()).toMatchObject({
      identityEdPubkeyHex: IDENTITY_B,
      pending: [persisted(inviteB)],
    })
    expect(storedEntries(fake, IDENTITY_B)).toEqual([persisted(inviteB)])
  })

  test('same-identity reconciliation revokes a removed friend immediately', async () => {
    const inv = signedInvite('removed-live-friend', NOW + 120_000)
    const fake = new FakeStore()
    __setPendingInviteStoreDeps({ storeFactory: () => fake })
    activate()
    await usePendingInvitesStore
      .getState()
      .reconcile(IDENTITY_A, new Set([inv.from_ed_pubkey]), NOW)
    add(inv)
    await __flushPendingInvitePersistence()

    const reconciliation = usePendingInvitesStore
      .getState()
      .reconcile(IDENTITY_A, new Set(), NOW + 1)
    expect(usePendingInvitesStore.getState().pending).toEqual([])
    await reconciliation
    await __flushPendingInvitePersistence()
    expect(fake.values.has(PENDING_INVITES_STORE_KEY)).toBe(false)
  })

  test('an older friend snapshot cannot undo removal during delayed reconciliation', async () => {
    const inv = signedInvite('removed-during-read', NOW + 120_000)
    const oldRead = deferred()
    const fake = new FakeStore()
    const oldSnapshot = snapshot(IDENTITY_A, [persisted(inv)])
    fake.values.set(PENDING_INVITES_STORE_KEY, oldSnapshot)
    let reads = 0
    fake.get = async <T>(key: string) => {
      reads += 1
      if (reads === 1) {
        await oldRead.promise
        return oldSnapshot as T
      }
      return fake.values.get(key) as T | undefined
    }
    __setPendingInviteStoreDeps({ storeFactory: () => fake })
    activate()

    const stale = usePendingInvitesStore
      .getState()
      .reconcile(IDENTITY_A, new Set([inv.from_ed_pubkey]), NOW)
    const current = usePendingInvitesStore
      .getState()
      .reconcile(IDENTITY_A, new Set(), NOW + 1)
    expect(usePendingInvitesStore.getState().pending).toEqual([])
    oldRead.resolve()
    await Promise.all([stale, current])
    await __flushPendingInvitePersistence()

    expect(usePendingInvitesStore.getState().pending).toEqual([])
    expect(fake.values.has(PENDING_INVITES_STORE_KEY)).toBe(false)
  })

  test('rejects forged future receipt times and far-future expiries', async () => {
    const valid = signedInvite('valid-window', NOW + 120_000)
    const futureReceived = signedInvite('future-received', NOW + 120_000)
    const farFuture = signedInvite('far-future', NOW + INVITE_TTL_MS * 100)
    const fake = new FakeStore()
    fake.values.set(
      PENDING_INVITES_STORE_KEY,
      snapshot(IDENTITY_A, [
        persisted(valid),
        persisted(futureReceived, NOW + 1),
        persisted(farFuture),
      ])
    )
    __setPendingInviteStoreDeps({ storeFactory: () => fake })

    activate()
    await usePendingInvitesStore
      .getState()
      .reconcile(
        IDENTITY_A,
        new Set([
          valid.from_ed_pubkey,
          futureReceived.from_ed_pubkey,
          farFuture.from_ed_pubkey,
        ]),
        NOW
      )

    expect(usePendingInvitesStore.getState().pending).toEqual([
      persisted(valid),
    ])
  })

  test.each([
    ['null root', null],
    ['wrong version', { v: 1, identityEdPubkeyHex: IDENTITY_A, entries: [] }],
    ['missing identity', { v: 2, entries: [] }],
    [
      'non-array entries',
      { v: 2, identityEdPubkeyHex: IDENTITY_A, entries: {} },
    ],
  ])('ignores a malformed persisted snapshot: %s', async (_name, raw) => {
    const fake = new FakeStore()
    fake.values.set(PENDING_INVITES_STORE_KEY, raw)
    __setPendingInviteStoreDeps({ storeFactory: () => fake })
    activate()

    await usePendingInvitesStore
      .getState()
      .reconcile(IDENTITY_A, new Set(), NOW)
    await __flushPendingInvitePersistence()

    expect(usePendingInvitesStore.getState().pending).toEqual([])
    expect(fake.values.has(PENDING_INVITES_STORE_KEY)).toBe(false)
  })

  test('leaves a future snapshot version untouched', async () => {
    const fake = new FakeStore()
    const futureSnapshot = {
      v: 3,
      identityEdPubkeyHex: IDENTITY_A,
      entries: [persisted(signedInvite('future-schema', NOW + 120_000))],
    }
    const live = signedInvite('live-with-future-schema', NOW + 120_000)
    fake.values.set(PENDING_INVITES_STORE_KEY, futureSnapshot)
    __setPendingInviteStoreDeps({ storeFactory: () => fake })
    activate()
    add(live)

    await usePendingInvitesStore
      .getState()
      .reconcile(IDENTITY_A, new Set([live.from_ed_pubkey]), NOW)
    await __flushPendingInvitePersistence()

    expect(usePendingInvitesStore.getState().pending).toEqual([persisted(live)])
    expect(fake.values.get(PENDING_INVITES_STORE_KEY)).toBe(futureSnapshot)
    expect(fake.sets).toEqual([])
    expect(fake.deletes).toEqual([])
  })

  test('rejects malformed and noncanonical entries without losing a valid one', async () => {
    const valid = signedInvite('canonical', NOW + 120_000)
    const malformed = {
      ...persisted(valid),
      invite: { ...valid, payload: null },
    }
    const wrongKey = { ...persisted(valid), key: 'not-the-canonical-key' }
    const fake = new FakeStore()
    fake.values.set(
      PENDING_INVITES_STORE_KEY,
      snapshot(IDENTITY_A, [null, {}, malformed, wrongKey, persisted(valid)])
    )
    __setPendingInviteStoreDeps({ storeFactory: () => fake })
    activate()

    await usePendingInvitesStore
      .getState()
      .reconcile(IDENTITY_A, new Set([valid.from_ed_pubkey]), NOW)

    expect(usePendingInvitesStore.getState().pending).toEqual([
      persisted(valid),
    ])
  })

  test('restores at most the newest sixteen persisted invites', async () => {
    const identity = generateIdentity()
    const invites = Array.from({ length: 20 }, (_, index) =>
      signedInvite(`capped-${index}`, NOW + 120_000, { identity })
    )
    const fake = new FakeStore()
    fake.values.set(
      PENDING_INVITES_STORE_KEY,
      snapshot(
        IDENTITY_A,
        invites.map((inv, index) => persisted(inv, NOW + index))
      )
    )
    __setPendingInviteStoreDeps({ storeFactory: () => fake })
    activate()

    await usePendingInvitesStore
      .getState()
      .reconcile(IDENTITY_A, new Set([invites[0].from_ed_pubkey]), NOW + 100)
    await __flushPendingInvitePersistence()

    expect(
      usePendingInvitesStore
        .getState()
        .pending.map((entry) => entry.invite.payload.session_topic)
    ).toEqual(invites.slice(4).map((inv) => inv.payload.session_topic))
    expect(storedEntries(fake)).toHaveLength(16)
  })

  test('drops a restored invite that expires while its read is delayed', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const inv = signedInvite('expires-during-read', NOW + 1_000)
    const read = deferred()
    const fake = new FakeStore()
    const diskSnapshot = snapshot(IDENTITY_A, [persisted(inv)])
    fake.values.set(PENDING_INVITES_STORE_KEY, diskSnapshot)
    fake.get = async <T>(key: string) => {
      const value = fake.values.get(key) as T | undefined
      await read.promise
      return value
    }
    __setPendingInviteStoreDeps({ storeFactory: () => fake })
    activate()

    const reconciliation = usePendingInvitesStore
      .getState()
      .reconcile(IDENTITY_A, new Set([inv.from_ed_pubkey]))
    vi.setSystemTime(NOW + 1_001)
    read.resolve()
    await reconciliation

    expect(usePendingInvitesStore.getState().pending).toEqual([])
  })

  test('prune uses the current clock when no timestamp is supplied', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    __setPendingInviteStoreDeps({ storeFactory: null })
    const inv = signedInvite('timer-prune', NOW + 10_000)
    activate()
    await usePendingInvitesStore
      .getState()
      .reconcile(IDENTITY_A, new Set([inv.from_ed_pubkey]))
    add(inv)

    vi.setSystemTime(NOW + 10_000)
    usePendingInvitesStore.getState().prune()

    expect(usePendingInvitesStore.getState().pending).toEqual([])
  })

  test('the store expires and persists invites while no UI is mounted', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const first = signedInvite('auto-expire-first', NOW + 1_000)
    const second = signedInvite('auto-expire-second', NOW + 5_000)
    const fake = new FakeStore()
    __setPendingInviteStoreDeps({ storeFactory: () => fake })
    activate()
    await usePendingInvitesStore
      .getState()
      .reconcile(
        IDENTITY_A,
        new Set([first.from_ed_pubkey, second.from_ed_pubkey]),
        NOW
      )
    add(first)
    add(second)
    await __flushPendingInvitePersistence()

    await vi.advanceTimersByTimeAsync(1_000)
    await __flushPendingInvitePersistence()
    expect(usePendingInvitesStore.getState().pending).toEqual([
      persisted(second),
    ])
    expect(storedEntries(fake)).toEqual([persisted(second)])

    await vi.advanceTimersByTimeAsync(4_000)
    await __flushPendingInvitePersistence()
    expect(usePendingInvitesStore.getState().pending).toEqual([])
    expect(fake.values.size).toBe(0)
  })

  test('a read failure degrades non-destructively and a later reconcile resumes persistence', async () => {
    const fake = new FakeStore()
    const unreadDisk = signedInvite('unread-disk', NOW + 120_000)
    const diskSnapshot = snapshot(IDENTITY_A, [persisted(unreadDisk)])
    fake.values.set(PENDING_INVITES_STORE_KEY, diskSnapshot)
    fake.getError = new Error('read failed')
    const live = signedInvite('live-through-read-error', NOW + 120_000)
    const afterRecovery = signedInvite('persist-after-recovery', NOW + 120_000)
    __setPendingInviteStoreDeps({ storeFactory: () => fake })
    activate()
    add(live)

    await usePendingInvitesStore
      .getState()
      .reconcile(IDENTITY_A, new Set([live.from_ed_pubkey]), NOW)
    await __flushPendingInvitePersistence()

    expect(usePendingInvitesStore.getState()).toMatchObject({
      status: 'degraded',
      pending: [persisted(live)],
    })
    expect(fake.values.get(PENDING_INVITES_STORE_KEY)).toBe(diskSnapshot)
    expect(fake.sets).toEqual([])
    expect(fake.deletes).toEqual([])

    fake.getError = null
    await usePendingInvitesStore
      .getState()
      .reconcile(
        IDENTITY_A,
        new Set([live.from_ed_pubkey, afterRecovery.from_ed_pubkey]),
        NOW + 1
      )
    expect(usePendingInvitesStore.getState().status).toBe('ready')
    expect(
      usePendingInvitesStore.getState().add(IDENTITY_A, afterRecovery, NOW + 2)
    ).toBe(true)
    await __flushPendingInvitePersistence()

    expect(storedEntries(fake)).toEqual([
      persisted(live),
      persisted(afterRecovery, NOW + 2),
    ])
  })

  test('a throwing store factory degrades without destroying live state', async () => {
    const live = signedInvite('live-through-factory-error', NOW + 120_000)
    __setPendingInviteStoreDeps({
      storeFactory: () => {
        throw new Error('factory failed')
      },
    })
    activate()
    add(live)

    await usePendingInvitesStore
      .getState()
      .reconcile(IDENTITY_A, new Set([live.from_ed_pubkey]), NOW)

    expect(usePendingInvitesStore.getState()).toMatchObject({
      status: 'degraded',
      pending: [persisted(live)],
    })
  })

  test.each(['set', 'save'] as const)(
    'a %s failure leaves memory intact and the persistence queue reusable',
    async (operation) => {
      const fake = new FakeStore()
      const first = signedInvite('write-fails', NOW + 120_000)
      const second = signedInvite('write-recovers', NOW + 120_000)
      __setPendingInviteStoreDeps({ storeFactory: () => fake })
      activate()
      await usePendingInvitesStore
        .getState()
        .reconcile(
          IDENTITY_A,
          new Set([first.from_ed_pubkey, second.from_ed_pubkey]),
          NOW
        )
      await __flushPendingInvitePersistence()

      if (operation === 'set') fake.setError = new Error('set failed')
      else fake.saveError = new Error('save failed')
      add(first)
      await __flushPendingInvitePersistence()
      expect(usePendingInvitesStore.getState().pending).toEqual([
        persisted(first),
      ])

      fake.setError = null
      fake.saveError = null
      add(second, NOW + 1)
      await __flushPendingInvitePersistence()
      expect(storedEntries(fake)).toEqual([
        persisted(first),
        persisted(second, NOW + 1),
      ])
    }
  )

  test('a delete failure leaves memory empty and can be retried', async () => {
    const fake = new FakeStore()
    const inv = signedInvite('delete-fails', NOW + 120_000)
    __setPendingInviteStoreDeps({ storeFactory: () => fake })
    activate()
    await usePendingInvitesStore
      .getState()
      .reconcile(IDENTITY_A, new Set([inv.from_ed_pubkey]), NOW)
    add(inv)
    await __flushPendingInvitePersistence()

    fake.deleteError = new Error('delete failed')
    usePendingInvitesStore.getState().remove(pendingInviteKey(inv))
    await __flushPendingInvitePersistence()
    expect(usePendingInvitesStore.getState().pending).toEqual([])
    expect(fake.values.has(PENDING_INVITES_STORE_KEY)).toBe(true)

    fake.deleteError = null
    usePendingInvitesStore.getState().clear()
    await __flushPendingInvitePersistence()
    expect(fake.values.has(PENDING_INVITES_STORE_KEY)).toBe(false)
  })

  test.each(['remove', 'prune', 'clear'] as const)(
    'persists %s so an invite cannot return after reconciliation',
    async (operation) => {
      const fake = new FakeStore()
      const inv = signedInvite('durable-removal', NOW + 60_000)
      __setPendingInviteStoreDeps({ storeFactory: () => fake })
      activate()
      await usePendingInvitesStore
        .getState()
        .reconcile(IDENTITY_A, new Set([inv.from_ed_pubkey]), NOW)
      add(inv)
      await __flushPendingInvitePersistence()

      if (operation === 'remove') {
        usePendingInvitesStore.getState().remove(pendingInviteKey(inv))
      } else if (operation === 'prune') {
        usePendingInvitesStore.getState().prune(NOW + 60_000)
      } else {
        usePendingInvitesStore.getState().clear()
      }
      await __flushPendingInvitePersistence()
      expect(fake.values.has(PENDING_INVITES_STORE_KEY)).toBe(false)

      usePendingInvitesStore.getState().deactivateExpected(IDENTITY_A)
      activate()
      await usePendingInvitesStore
        .getState()
        .reconcile(
          IDENTITY_A,
          new Set([inv.from_ed_pubkey]),
          operation === 'prune' ? NOW + 60_001 : NOW + 1
        )
      expect(usePendingInvitesStore.getState().pending).toEqual([])
    }
  )
})
