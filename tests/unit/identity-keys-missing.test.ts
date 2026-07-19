import { beforeEach, describe, expect, test, vi } from 'vitest'

// #47 E1 follow-up — the keys-missing route used to DISCARD the successfully
// parsed identity.json: the Recover mount got no fingerprint (so typing your
// OWN 24 words hit the scary "replace identity?" confirm and the done screen
// claimed friends were lost), and buildCommit fell back to display_name ''
// (permanent — onboarding never re-prompts — and a blank name silently
// disables invite sending). The parsed record is now retained as
// `staleRecord` and threaded through both paths.

const saved: { keys: unknown[]; records: unknown[] } = {
  keys: [],
  records: [],
}
let storedRecord: Record<string, unknown> | null = null
let keysPresent = false

vi.mock('@/lib/db/identity', () => ({
  IDENTITY_VERSION: 1,
  identityExists: vi.fn(async () => storedRecord !== null),
  loadIdentityRecord: vi.fn(async () => storedRecord),
  identityKeysPresent: vi.fn(async () => keysPresent),
  saveKeys: vi.fn(async (...args: unknown[]) => {
    saved.keys.push(args)
  }),
  saveIdentityRecord: vi.fn(async (record: unknown) => {
    saved.records.push(record)
  }),
  signWithKeyring: vi.fn(async () => new Uint8Array(64)),
}))

import { generateIdentity, mnemonicFingerprint } from '@/lib/crypto/identity'
import { decideOverwrite } from '@/features/identity/recoverLogic'
import { useIdentityStore } from '@/stores/identityStore'

describe('keys-missing retains the parsed record (#47 E1 follow-up)', () => {
  const id = generateIdentity()

  beforeEach(() => {
    saved.keys.length = 0
    saved.records.length = 0
    keysPresent = false
    storedRecord = {
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
    expect(saved.records).toHaveLength(1)
    expect((saved.records[0] as { display_name: string }).display_name).toBe(
      'Sam'
    )
  })

  test('a ready boot (keys present) leaves staleRecord null', async () => {
    keysPresent = true
    await useIdentityStore.getState().actions.refresh()
    const s = useIdentityStore.getState()
    expect(s.status).toBe('ready')
    expect(s.staleRecord).toBeNull()
  })
})
