// #225 — the sealed interrupted-session record: what it writes, what it
// refuses to open, and which endings clear it.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import {
  __flushSessionRecovery,
  __resetSessionRecoveryDeps,
  __setSessionRecoveryDeps,
  clearSessionRecovery,
  clearSessionRecoveryOnLeave,
  isSessionRecoveryRetainedForQuit,
  loadSessionRecovery,
  rememberActiveSession,
  retainSessionRecoveryForQuit,
  saveSessionRecovery,
  SESSION_RECOVERY_KEY,
  SESSION_RECOVERY_MAX_AGE_MS,
  type SessionRecoveryDeps,
  type SessionRecoveryStoreLike,
} from '@/features/session/recovery'
import { DEFAULT_DECLARED_STUDY_TOPIC } from '@/stores/sessionStore'

const OWNER = {
  edPubkeyHex: 'A'.repeat(64),
  xPubkeyHex: '11'.repeat(32),
}
const OTHER_X_PUBKEY = '22'.repeat(32)

const RECORD = {
  sessionTopic: 'c'.repeat(64),
  sessionPassword: 'cGFzc3dvcmQtYnl0ZXM=',
  isHost: false,
  expectedAuthorityEdPubkeyHex: 'b'.repeat(64),
  declaredStudyTopic: 'Organic chemistry',
  startedAt: 1_700_000_000_000,
}

// A NaCl-box stand-in: reversible, and keyed on the public key it was sealed
// to so a wrong-identity open fails the way the real one does.
function fakeCrypto() {
  const seal = vi.fn(async (theirXPub: Uint8Array, plaintext: Uint8Array) => ({
    nonce: new Uint8Array([1, 2, 3]),
    ciphertext: Uint8Array.from([
      ...theirXPub.slice(0, 4),
      ...plaintext.map((byte) => byte ^ 0x5a),
    ]),
  }))
  const open = vi.fn(
    async (
      theirXPub: Uint8Array,
      _nonce: Uint8Array,
      ciphertext: Uint8Array
    ) => {
      const tag = ciphertext.slice(0, 4)
      if (tag.some((byte, i) => byte !== theirXPub[i])) {
        throw new Error('decryption failed')
      }
      return ciphertext.slice(4).map((byte) => byte ^ 0x5a)
    }
  )
  return { seal, open }
}

class FakeStore implements SessionRecoveryStoreLike {
  values = new Map<string, unknown>()
  saves = 0
  failReads = false

  async get<T>(key: string): Promise<T | undefined> {
    if (this.failReads) throw new Error('store unavailable')
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

let store: FakeStore
let crypto: ReturnType<typeof fakeCrypto>

function install(overrides: Partial<SessionRecoveryDeps> = {}): void {
  __setSessionRecoveryDeps({
    storeFactory: () => store,
    seal: crypto.seal,
    open: crypto.open,
    ...overrides,
  })
}

beforeEach(() => {
  store = new FakeStore()
  crypto = fakeCrypto()
  install()
})

afterEach(() => {
  __resetSessionRecoveryDeps()
})

describe('sealed record round-trip', () => {
  test('writes an identity-scoped envelope and reads the record back', async () => {
    await saveSessionRecovery(OWNER, RECORD, 1_700_000_100_000)
    await __flushSessionRecovery()

    expect(store.saves).toBe(1)
    const envelope = store.values.get(SESSION_RECOVERY_KEY) as {
      v: number
      identityEdPubkeyHex: string
      savedAt: number
      nonce: string
      ciphertext: string
    }
    expect(envelope.v).toBe(1)
    // Scoping is readable at rest; the credentials are not.
    expect(envelope.identityEdPubkeyHex).toBe(OWNER.edPubkeyHex.toLowerCase())
    expect(envelope.savedAt).toBe(1_700_000_100_000)

    const loaded = await loadSessionRecovery(OWNER, 1_700_000_200_000)
    expect(loaded).toEqual({
      kind: 'record',
      record: { ...RECORD, savedAt: 1_700_000_100_000 },
    })
  })

  test('never writes the topic or password in the clear', async () => {
    await saveSessionRecovery(OWNER, RECORD, 1_700_000_100_000)
    await __flushSessionRecovery()

    const serialized = JSON.stringify(store.values.get(SESSION_RECOVERY_KEY))
    expect(serialized).not.toContain(RECORD.sessionTopic)
    expect(serialized).not.toContain(RECORD.sessionPassword)
    expect(serialized).not.toContain(RECORD.declaredStudyTopic)
    expect(serialized).not.toContain(RECORD.expectedAuthorityEdPubkeyHex)
  })

  test('a record written by another identity is neither used nor deleted', async () => {
    await saveSessionRecovery(OWNER, RECORD, 1_700_000_100_000)
    await __flushSessionRecovery()

    const stranger = { edPubkeyHex: 'f'.repeat(64), xPubkeyHex: OTHER_X_PUBKEY }
    await expect(
      loadSessionRecovery(stranger, 1_700_000_200_000)
    ).resolves.toEqual({ kind: 'none' })
    expect(store.values.has(SESSION_RECOVERY_KEY)).toBe(true)
  })

  test('a record this identity cannot open is kept for the next boot', async () => {
    await saveSessionRecovery(OWNER, RECORD, 1_700_000_100_000)
    await __flushSessionRecovery()

    // Same identity in the envelope, but the keychain answers with a
    // different key — a transient failure, not a corrupt record.
    const loaded = await loadSessionRecovery(
      { ...OWNER, xPubkeyHex: OTHER_X_PUBKEY },
      1_700_000_200_000
    )
    expect(loaded).toEqual({ kind: 'unavailable' })
    expect(store.values.has(SESSION_RECOVERY_KEY)).toBe(true)
  })

  test('a failed store read reports unavailable rather than none', async () => {
    await saveSessionRecovery(OWNER, RECORD, 1_700_000_100_000)
    await __flushSessionRecovery()
    store.failReads = true

    await expect(
      loadSessionRecovery(OWNER, 1_700_000_200_000)
    ).resolves.toEqual({ kind: 'unavailable' })
    expect(store.values.has(SESSION_RECOVERY_KEY)).toBe(true)
  })
})

describe('records this build refuses to act on', () => {
  test('drops a record older than the maximum age', async () => {
    await saveSessionRecovery(OWNER, RECORD, 1_700_000_100_000)
    await __flushSessionRecovery()

    const loaded = await loadSessionRecovery(
      OWNER,
      1_700_000_100_000 + SESSION_RECOVERY_MAX_AGE_MS + 1
    )
    expect(loaded).toEqual({ kind: 'none' })
    expect(store.values.has(SESSION_RECOVERY_KEY)).toBe(false)
  })

  test('keeps a record that is exactly at the maximum age', async () => {
    await saveSessionRecovery(OWNER, RECORD, 1_700_000_100_000)
    await __flushSessionRecovery()

    const loaded = await loadSessionRecovery(
      OWNER,
      1_700_000_100_000 + SESSION_RECOVERY_MAX_AGE_MS
    )
    expect(loaded).toMatchObject({ kind: 'record' })
  })

  test('drops a host record rather than offering an unreachable room', async () => {
    await saveSessionRecovery(
      OWNER,
      { ...RECORD, isHost: true },
      1_700_000_100_000
    )
    await __flushSessionRecovery()

    await expect(
      loadSessionRecovery(OWNER, 1_700_000_200_000)
    ).resolves.toEqual({ kind: 'none' })
    expect(store.values.has(SESSION_RECOVERY_KEY)).toBe(false)
  })

  test('drops a record stamped in the future', async () => {
    await saveSessionRecovery(OWNER, RECORD, 1_700_000_100_000)
    await __flushSessionRecovery()

    await expect(
      loadSessionRecovery(OWNER, 1_700_000_000_000)
    ).resolves.toEqual({ kind: 'none' })
    expect(store.values.has(SESSION_RECOVERY_KEY)).toBe(false)
  })

  test('ignores an envelope from a future record version', async () => {
    await saveSessionRecovery(OWNER, RECORD, 1_700_000_100_000)
    await __flushSessionRecovery()
    const envelope = store.values.get(SESSION_RECOVERY_KEY) as {
      v: number
    }
    store.values.set(SESSION_RECOVERY_KEY, { ...envelope, v: 2 })

    await expect(
      loadSessionRecovery(OWNER, 1_700_000_200_000)
    ).resolves.toEqual({ kind: 'none' })
    // A newer build's record is not ours to delete.
    expect(store.values.has(SESSION_RECOVERY_KEY)).toBe(true)
  })

  test('rejects a sealed payload without the recovery domain tag', async () => {
    // Something else sealed to this identity's own key — an invite envelope
    // addressed to self, for instance — must not decode as a room capability.
    const foreign = new TextEncoder().encode(
      JSON.stringify({
        session_topic: 'not-a-recovery-record',
        session_password: 'nope',
      })
    )
    const { nonce, ciphertext } = await crypto.seal(
      Uint8Array.from(
        (OWNER.xPubkeyHex.match(/../g) ?? []).map((b) => parseInt(b, 16))
      ),
      foreign
    )
    store.values.set(SESSION_RECOVERY_KEY, {
      v: 1,
      identityEdPubkeyHex: OWNER.edPubkeyHex.toLowerCase(),
      savedAt: 1_700_000_100_000,
      nonce: btoa(String.fromCharCode(...nonce)),
      ciphertext: btoa(String.fromCharCode(...ciphertext)),
    })

    await expect(
      loadSessionRecovery(OWNER, 1_700_000_200_000)
    ).resolves.toEqual({ kind: 'none' })
    expect(store.values.has(SESSION_RECOVERY_KEY)).toBe(false)
  })
})

describe('clearing', () => {
  test('an ordinary leave clears the record', async () => {
    await saveSessionRecovery(OWNER, RECORD, 1_700_000_100_000)
    await clearSessionRecoveryOnLeave()
    await __flushSessionRecovery()

    expect(store.values.has(SESSION_RECOVERY_KEY)).toBe(false)
  })

  test('a confirmed quit keeps the record through the same leave handler', async () => {
    await saveSessionRecovery(OWNER, RECORD, 1_700_000_100_000)
    await __flushSessionRecovery()

    retainSessionRecoveryForQuit()
    expect(isSessionRecoveryRetainedForQuit()).toBe(true)
    await clearSessionRecoveryOnLeave()
    await __flushSessionRecovery()

    expect(store.values.has(SESSION_RECOVERY_KEY)).toBe(true)
    await expect(
      loadSessionRecovery(OWNER, 1_700_000_200_000)
    ).resolves.toMatchObject({ kind: 'record' })
  })

  test('a new session cancels a previous quit retention', async () => {
    retainSessionRecoveryForQuit()
    await saveSessionRecovery(OWNER, RECORD, 1_700_000_100_000)
    await __flushSessionRecovery()

    expect(isSessionRecoveryRetainedForQuit()).toBe(false)
    await clearSessionRecoveryOnLeave()
    await __flushSessionRecovery()
    expect(store.values.has(SESSION_RECOVERY_KEY)).toBe(false)
  })

  test('the explicit End choice clears the record outright', async () => {
    await saveSessionRecovery(OWNER, RECORD, 1_700_000_100_000)
    retainSessionRecoveryForQuit()
    await clearSessionRecovery()
    await __flushSessionRecovery()

    expect(store.values.has(SESSION_RECOVERY_KEY)).toBe(false)
  })

  test('a save that lands after a leave cannot resurrect the record', async () => {
    // Both operations run through one queue, so ordering is by call, not by
    // whichever store write happens to finish first.
    const save = saveSessionRecovery(OWNER, RECORD, 1_700_000_100_000)
    const cleared = clearSessionRecoveryOnLeave()
    await Promise.all([save, cleared])
    await __flushSessionRecovery()

    expect(store.values.has(SESSION_RECOVERY_KEY)).toBe(false)
  })
})

describe('rememberActiveSession', () => {
  test('writes nothing without an identity', async () => {
    rememberActiveSession({
      identity: null,
      sessionTopic: RECORD.sessionTopic,
      sessionPassword: RECORD.sessionPassword,
      isHost: false,
      expectedAuthorityEdPubkeyHex: null,
      declaredStudyTopic: 'Anything',
      startedAt: RECORD.startedAt,
    })
    await __flushSessionRecovery()

    expect(store.values.has(SESSION_RECOVERY_KEY)).toBe(false)
  })

  // A host stint is not recoverable: the survivors froze admissions against
  // the departed host's transport id, which a relaunch cannot present.
  test('writes nothing for a host stint', async () => {
    rememberActiveSession({
      identity: {
        ed_pubkey_hex: OWNER.edPubkeyHex,
        x_pubkey_hex: OWNER.xPubkeyHex,
      },
      sessionTopic: RECORD.sessionTopic,
      sessionPassword: RECORD.sessionPassword,
      isHost: true,
      expectedAuthorityEdPubkeyHex: null,
      declaredStudyTopic: 'Anything',
      startedAt: RECORD.startedAt,
    })
    await __flushSessionRecovery()

    expect(crypto.seal).not.toHaveBeenCalled()
    expect(store.values.has(SESSION_RECOVERY_KEY)).toBe(false)
  })

  test('does not carry the placeholder study topic into the prompt', async () => {
    rememberActiveSession({
      identity: {
        ed_pubkey_hex: OWNER.edPubkeyHex,
        x_pubkey_hex: OWNER.xPubkeyHex,
      },
      sessionTopic: RECORD.sessionTopic,
      sessionPassword: RECORD.sessionPassword,
      isHost: false,
      expectedAuthorityEdPubkeyHex: null,
      declaredStudyTopic: DEFAULT_DECLARED_STUDY_TOPIC,
      startedAt: RECORD.startedAt,
    })
    await __flushSessionRecovery()

    // rememberActiveSession stamps the write itself, so read at wall time.
    const loaded = await loadSessionRecovery(OWNER)
    expect(loaded).toMatchObject({
      kind: 'record',
      record: { declaredStudyTopic: null, isHost: false },
    })
  })

  test('is inert when there is no store to write to', async () => {
    install({ storeFactory: null })
    rememberActiveSession({
      identity: {
        ed_pubkey_hex: OWNER.edPubkeyHex,
        x_pubkey_hex: OWNER.xPubkeyHex,
      },
      sessionTopic: RECORD.sessionTopic,
      sessionPassword: RECORD.sessionPassword,
      isHost: false,
      expectedAuthorityEdPubkeyHex: null,
      declaredStudyTopic: 'Anything',
      startedAt: RECORD.startedAt,
    })
    await __flushSessionRecovery()

    expect(crypto.seal).not.toHaveBeenCalled()
    await expect(loadSessionRecovery(OWNER)).resolves.toEqual({ kind: 'none' })
  })
})
