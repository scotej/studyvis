import { beforeEach, describe, expect, test, vi } from 'vitest'

// #47 E1 follow-up — the keys-missing route used to DISCARD the successfully
// parsed identity.json: the Recover mount got no fingerprint (so typing your
// OWN 24 words hit the scary "replace identity?" confirm and the done screen
// claimed friends were lost), and buildCommit fell back to display_name ''
// (permanent — onboarding never re-prompts — and a blank name silently
// disables invite sending). The parsed record is now retained as
// `staleRecord` and threaded through both paths.

const mockState = vi.hoisted(() => ({
  saved: { keys: [] as unknown[], records: [] as unknown[] },
  storedRecord: null as Record<string, unknown> | null,
  keysPresent: false,
  keysInvalid: false,
  keysProbeError: null as unknown,
  recordSaveFails: false,
  keysGate: null as Promise<void> | null,
  statusGate: null as Promise<void> | null,
  recordGate: null as Promise<void> | null,
}))

vi.mock('@/lib/db/identity', () => ({
  IDENTITY_VERSION: 1,
  identityExists: vi.fn(async () => mockState.storedRecord !== null),
  loadIdentityRecord: vi.fn(async () => mockState.storedRecord),
  identityKeysStatus: vi.fn(async () => {
    const gate = mockState.statusGate
    if (gate) await gate
    if (mockState.keysProbeError !== null) throw mockState.keysProbeError
    return mockState.keysInvalid
      ? 'invalid'
      : mockState.keysPresent
        ? 'matching'
        : 'missing'
  }),
  saveKeys: vi.fn(async (...args: unknown[]) => {
    mockState.saved.keys.push(args)
    if (mockState.keysGate) await mockState.keysGate
    if (mockState.recordSaveFails) mockState.keysInvalid = true
  }),
  saveIdentityRecord: vi.fn(async (record: unknown) => {
    if (mockState.recordGate) await mockState.recordGate
    if (mockState.recordSaveFails) throw new Error('record replacement failed')
    mockState.saved.records.push(record)
  }),
  signWithKeyring: vi.fn(async () => new Uint8Array(64)),
  boxEncryptWithKeyring: vi.fn(),
  boxDecryptWithKeyring: vi.fn(),
}))

import { generateIdentity, mnemonicFingerprint } from '@/lib/crypto/identity'
import { decideOverwrite } from '@/features/identity/recoverLogic'
import { useIdentityStore } from '@/stores/identityStore'
import { useSessionStore } from '@/stores/sessionStore'
import { strings } from '@/strings'

describe('keys-missing retains the parsed record (#47 E1 follow-up)', () => {
  const id = generateIdentity()

  beforeEach(() => {
    mockState.saved.keys.length = 0
    mockState.saved.records.length = 0
    mockState.keysPresent = false
    mockState.keysInvalid = false
    mockState.recordSaveFails = false
    mockState.keysGate = null
    mockState.statusGate = null
    mockState.recordGate = null
    useSessionStore.getState().reset()
    mockState.keysProbeError = null
    mockState.storedRecord = {
      version: 1,
      ed_pubkey_hex: 'aa'.repeat(32),
      x_pubkey_hex: 'bb'.repeat(32),
      display_name: 'Sam',
      created_at: 1_700_000_000_000,
      mnemonic_fingerprint: mnemonicFingerprint(id.mnemonic),
    }
  })

  test('refresh routes to keys-missing and keeps the record as staleRecord', async () => {
    await useIdentityStore.getState().actions.refresh()
    const s = useIdentityStore.getState()
    expect(s.status).toBe('error')
    expect(s.errorKind).toBe('keys-missing')
    expect(s.identity).toBeNull() // never presented as usable
    expect(s.staleRecord?.display_name).toBe('Sam')
    expect(s.staleRecord?.mnemonic_fingerprint).toBe(
      mnemonicFingerprint(id.mnemonic)
    )
  })

  test("the user's own words take the same-identity fast path (no overwrite scare)", async () => {
    await useIdentityStore.getState().actions.refresh()
    const fingerprint =
      useIdentityStore.getState().staleRecord?.mnemonic_fingerprint
    expect(decideOverwrite(id.mnemonic, true, fingerprint)).toBe('commit')
    // Different words still get the escalated destructive-replace warning.
    const other = generateIdentity()
    expect(decideOverwrite(other.mnemonic, true, fingerprint)).toBe(
      'confirm-different'
    )
  })

  test('recovery preserves the display name and clears staleRecord', async () => {
    await useIdentityStore.getState().actions.refresh()
    const { record, commit } = useIdentityStore
      .getState()
      .actions.recover(id.mnemonic)
    expect(record.display_name).toBe('Sam')
    await commit()
    const s = useIdentityStore.getState()
    expect(s.status).toBe('ready')
    expect(s.identity?.display_name).toBe('Sam')
    expect(s.staleRecord).toBeNull()
    expect(mockState.saved.records).toHaveLength(1)
    expect(
      (mockState.saved.records[0] as { display_name: string }).display_name
    ).toBe('Sam')
  })

  test('a ready boot (keys present) leaves staleRecord null', async () => {
    mockState.keysPresent = true
    await useIdentityStore.getState().actions.refresh()
    const s = useIdentityStore.getState()
    expect(s.status).toBe('ready')
    expect(s.staleRecord).toBeNull()
  })

  test('a rejected credential probe blocks boot without claiming the keys are missing', async () => {
    mockState.keysProbeError = new Error(
      'Linux Secret Service is unavailable or locked. Start or unlock KWallet.'
    )
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined)
    try {
      await useIdentityStore.getState().actions.refresh()
    } finally {
      consoleError.mockRestore()
    }

    const s = useIdentityStore.getState()
    expect(s.status).toBe('error')
    expect(s.errorKind).toBe('keychain-unavailable')
    expect(s.identity).toBeNull()
    expect(s.staleRecord?.display_name).toBe('Sam')
  })

  test('retry can leave the unavailable state once the credential store unlocks', async () => {
    mockState.keysProbeError = new Error('credential store locked')
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined)
    try {
      await useIdentityStore.getState().actions.refresh()
    } finally {
      consoleError.mockRestore()
    }

    mockState.keysProbeError = null
    mockState.keysPresent = true
    await useIdentityStore.getState().actions.refresh()

    const s = useIdentityStore.getState()
    expect(s.status).toBe('ready')
    expect(s.errorKind).toBeNull()
    expect(s.identity?.display_name).toBe('Sam')
    expect(s.staleRecord).toBeNull()
  })
  test('mismatched or malformed credentials are recoverable and never ready', async () => {
    mockState.keysPresent = true
    mockState.keysInvalid = true
    await useIdentityStore.getState().actions.refresh()
    expect(useIdentityStore.getState()).toMatchObject({
      status: 'error',
      errorKind: 'keys-invalid',
      identity: null,
      staleRecord: { display_name: 'Sam' },
    })
  })
  test('refresh rejects a partial replacement after keys save but record save fails', async () => {
    mockState.keysPresent = true
    await useIdentityStore.getState().actions.refresh()
    expect(useIdentityStore.getState().status).toBe('ready')
    mockState.recordSaveFails = true
    const replacement = generateIdentity()
    const { commit } = useIdentityStore
      .getState()
      .actions.recover(replacement.mnemonic)
    await expect(commit()).rejects.toThrow('record replacement failed')
    expect(mockState.saved.keys).toHaveLength(1)
    await useIdentityStore.getState().actions.refresh()
    expect(useIdentityStore.getState()).toMatchObject({
      status: 'error',
      errorKind: 'keys-invalid',
      identity: null,
    })
    expect(useIdentityStore.getState().staleRecord).toEqual(
      mockState.storedRecord
    )
  })
  test('a prepared different-identity restore is rejected if a session begins before commit', async () => {
    mockState.keysPresent = true
    await useIdentityStore.getState().actions.refresh()
    const restore = useIdentityStore
      .getState()
      .actions.recover(generateIdentity().mnemonic)
    useSessionStore.getState().begin({
      sessionTopic: 'topic',
      sessionPassword: 'password',
      isHost: true,
      startedAt: 1,
      room: {} as never,
      leave: async () => {},
    })
    await expect(restore.commit()).rejects.toThrow(
      strings.identity.sessionRestoreBlocked
    )
    expect(mockState.saved.keys).toHaveLength(0)
    expect(useSessionStore.getState().status).toBe('active')
  })

  test.each(['keys', 'record'] as const)(
    'pending %s replacement blocks every session admission',
    async (phase) => {
      mockState.keysPresent = true
      await useIdentityStore.getState().actions.refresh()
      let resolve!: () => void
      const barrier = new Promise<void>((done) => (resolve = done))
      if (phase === 'keys') mockState.keysGate = barrier
      else mockState.recordGate = barrier
      const restore = useIdentityStore
        .getState()
        .actions.recover(generateIdentity().mnemonic)
        .commit()
      await vi.waitFor(() => expect(mockState.saved.keys).toHaveLength(1))
      const { hostSession } = await import('@/features/session/host')
      const { joinSession, rejoinSession } =
        await import('@/features/session/join')
      expect(() => hostSession()).toThrow(strings.identity.sessionStartBlocked)
      expect(() => joinSession('topic', 'password')).toThrow(
        strings.identity.sessionStartBlocked
      )
      expect(() => rejoinSession('topic', 'password', false)).toThrow(
        strings.identity.sessionStartBlocked
      )
      expect(() => useSessionStore.getState().begin({} as never)).toThrow(
        strings.identity.sessionStartBlocked
      )
      resolve()
      await restore
      expect(useIdentityStore.getState().status).toBe('ready')
    }
  )

  test('same-identity recovery remains available during a session', async () => {
    const prepared = useIdentityStore.getState().actions.recover(id.mnemonic)
    mockState.storedRecord = prepared.record
    mockState.keysPresent = true
    await useIdentityStore.getState().actions.refresh()
    useSessionStore.getState().begin({
      sessionTopic: 'topic',
      sessionPassword: 'password',
      isHost: true,
      startedAt: 1,
      room: {} as never,
      leave: async () => {},
    })
    await useIdentityStore.getState().actions.recover(id.mnemonic).commit()
    expect(useSessionStore.getState().status).toBe('active')
    expect(useIdentityStore.getState().identity?.ed_pubkey_hex).toBe(
      prepared.record.ed_pubkey_hex
    )
    expect(mockState.saved.keys).toHaveLength(1)
  })

  test('record replacement failure refreshes into the recovery gate before unlocking admissions', async () => {
    mockState.keysPresent = true
    await useIdentityStore.getState().actions.refresh()
    mockState.recordSaveFails = true
    await expect(
      useIdentityStore
        .getState()
        .actions.recover(generateIdentity().mnemonic)
        .commit()
    ).rejects.toThrow('record replacement failed')
    expect(useIdentityStore.getState()).toMatchObject({
      status: 'error',
      errorKind: 'keys-invalid',
      identity: null,
    })
  })
  test('a superseding refresh cannot leave the old identity ready after a partial replacement', async () => {
    mockState.keysPresent = true
    await useIdentityStore.getState().actions.refresh()
    mockState.recordSaveFails = true
    let verify!: () => void
    mockState.statusGate = new Promise<void>((done) => (verify = done))
    const { identityKeysStatus } = await import('@/lib/db/identity')
    const callsBefore = vi.mocked(identityKeysStatus).mock.calls.length
    const pending = useIdentityStore
      .getState()
      .actions.recover(generateIdentity().mnemonic)
      .commit()
    const rejected = expect(pending).rejects.toThrow(
      'record replacement failed'
    )
    await vi.waitFor(() =>
      expect(vi.mocked(identityKeysStatus).mock.calls.length).toBe(
        callsBefore + 1
      )
    )
    let finishSuperseding!: () => void
    mockState.statusGate = new Promise<void>(
      (done) => (finishSuperseding = done)
    )
    const superseding = useIdentityStore.getState().actions.refresh()
    await vi.waitFor(() =>
      expect(vi.mocked(identityKeysStatus).mock.calls.length).toBe(
        callsBefore + 2
      )
    )
    verify()
    await rejected
    expect(useIdentityStore.getState()).toMatchObject({
      identity: null,
      status: 'error',
      errorKind: 'keys-invalid',
    })
    finishSuperseding()
    await superseding
    expect(useIdentityStore.getState()).toMatchObject({
      identity: null,
      status: 'error',
      errorKind: 'keys-invalid',
    })
  })

  test('a concurrent replacement cannot overtake same-identity recovery', async () => {
    const prepared = useIdentityStore.getState().actions.recover(id.mnemonic)
    mockState.storedRecord = prepared.record
    mockState.keysPresent = true
    await useIdentityStore.getState().actions.refresh()
    let resolve!: () => void
    mockState.keysGate = new Promise<void>((done) => (resolve = done))
    const recovering = useIdentityStore
      .getState()
      .actions.recover(id.mnemonic)
      .commit()
    await expect(
      useIdentityStore
        .getState()
        .actions.recover(generateIdentity().mnemonic)
        .commit()
    ).rejects.toThrow(strings.identity.commitInProgress)
    resolve()
    await recovering
    expect(mockState.saved.keys).toHaveLength(1)
  })
  test('a stale identity refresh cannot republish A after a replacement commits B', async () => {
    mockState.keysPresent = true
    await useIdentityStore.getState().actions.refresh()
    let resolve!: () => void
    mockState.statusGate = new Promise<void>((done) => (resolve = done))
    const stale = useIdentityStore.getState().actions.refresh()
    await Promise.resolve()
    await Promise.resolve()
    const replacement = useIdentityStore
      .getState()
      .actions.recover(generateIdentity().mnemonic)
    await replacement.commit()
    resolve()
    await stale
    expect(useIdentityStore.getState().identity?.ed_pubkey_hex).toBe(
      replacement.record.ed_pubkey_hex
    )
  })

  test('a delayed display-name write excludes identity replacement until it finishes', async () => {
    mockState.keysPresent = true
    await useIdentityStore.getState().actions.refresh()
    let finishName!: () => void
    mockState.recordGate = new Promise<void>((done) => (finishName = done))
    const renaming = useIdentityStore.getState().actions.setDisplayName('Alex')
    mockState.recordGate = null
    try {
      await expect(
        useIdentityStore
          .getState()
          .actions.recover(generateIdentity().mnemonic)
          .commit()
      ).rejects.toThrow(strings.identity.commitInProgress)
      expect(mockState.saved.keys).toHaveLength(0)
    } finally {
      finishName()
      await renaming
    }
  })

  test('a pending recovery excludes display-name writes until it finishes', async () => {
    mockState.keysPresent = true
    await useIdentityStore.getState().actions.refresh()
    let finishKeys!: () => void
    mockState.keysGate = new Promise<void>((done) => (finishKeys = done))
    const replacement = useIdentityStore
      .getState()
      .actions.recover(generateIdentity().mnemonic)
    const recovering = replacement.commit()
    try {
      await expect(
        useIdentityStore.getState().actions.setDisplayName('Alex')
      ).rejects.toThrow(strings.identity.commitInProgress)
      expect(mockState.saved.records).toHaveLength(0)
    } finally {
      finishKeys()
      await recovering
    }
    expect(useIdentityStore.getState().identity).toEqual(replacement.record)
  })

  test.each(['before', 'during'] as const)(
    'a session beginning %s a display-name write preserves the active identity',
    async (when) => {
      mockState.keysPresent = true
      await useIdentityStore.getState().actions.refresh()
      const original = useIdentityStore.getState().identity!
      let finishName!: () => void
      mockState.recordGate = new Promise<void>((done) => (finishName = done))
      const begin = () =>
        useSessionStore.getState().begin({
          sessionTopic: 'topic',
          sessionPassword: 'password',
          isHost: true,
          startedAt: 1,
          room: {} as never,
          leave: async () => {},
        })
      if (when === 'before') begin()
      const renaming = useIdentityStore
        .getState()
        .actions.setDisplayName('Alex')
      if (when === 'during') begin()
      finishName()
      await renaming
      expect(useSessionStore.getState().status).toBe('active')
      expect(useIdentityStore.getState().identity).toEqual({
        ...original,
        display_name: 'Alex',
      })
      expect(mockState.saved.keys).toHaveLength(0)
    }
  )

  test('a failed name save releases ownership for retry and recovery', async () => {
    mockState.keysPresent = true
    await useIdentityStore.getState().actions.refresh()
    mockState.recordSaveFails = true
    await expect(
      useIdentityStore.getState().actions.setDisplayName('Alex')
    ).rejects.toThrow('record replacement failed')
    mockState.recordSaveFails = false
    await useIdentityStore.getState().actions.setDisplayName('Alex')
    await useIdentityStore
      .getState()
      .actions.recover(generateIdentity().mnemonic)
      .commit()
    expect(mockState.saved.keys).toHaveLength(1)
  })

  test('a stale refresh cannot revert a completed display-name write', async () => {
    mockState.keysPresent = true
    await useIdentityStore.getState().actions.refresh()
    let finishStatus!: () => void
    mockState.statusGate = new Promise<void>((done) => (finishStatus = done))
    const stale = useIdentityStore.getState().actions.refresh()
    await Promise.resolve()
    await Promise.resolve()
    await useIdentityStore.getState().actions.setDisplayName('Alex')
    finishStatus()
    await stale
    expect(useIdentityStore.getState().identity?.display_name).toBe('Alex')
  })
})
