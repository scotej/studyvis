import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { LabBackend } from '../../lab/src/backend'
import {
  bytesToHex,
  generateIdentity,
  type Identity,
} from '@/lib/crypto/identity'

const machines: { backend: LabBackend; dir: string }[] = []
afterEach(() => {
  for (const { backend, dir } of machines.splice(0)) {
    backend.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

function machine() {
  const dir = mkdtempSync(path.join(tmpdir(), 'studyvis-lab-identity-status-'))
  const backend = new LabBackend({ name: 'identity-test', dir, emit() {} })
  machines.push({ backend, dir })
  return backend
}
function fixture(id: Identity) {
  return {
    keys: { edPrivHex: bytesToHex(id.edPriv), xPrivHex: bytesToHex(id.xPriv) },
    record: {
      version: 1,
      ed_pubkey_hex: bytesToHex(id.edPub),
      x_pubkey_hex: bytesToHex(id.xPub),
      display_name: 'Test',
      created_at: 1,
      mnemonic_fingerprint: 'test',
    },
  }
}

const a = fixture(generateIdentity())
const b = fixture(generateIdentity())

test('the lab bootstrap IPC derives both keys and accepts hex case after reload', async () => {
  const backend = machine()
  backend.identity.preload(a.keys, {
    ...a.record,
    ed_pubkey_hex: a.record.ed_pubkey_hex.toUpperCase(),
    x_pubkey_hex: a.record.x_pubkey_hex.toUpperCase(),
  })
  const record = await backend.invoke('identity_load_record', {})
  await expect(
    backend.invoke('identity_keys_status', { record })
  ).resolves.toBe('matching')
  expect(backend.unhandled.size).toBe(0)
})

test('a saved public record without protected keys reports missing', async () => {
  const backend = machine()
  backend.identity.saveRecord(a.record)
  await expect(
    backend.invoke('identity_keys_status', { record: a.record })
  ).resolves.toBe('missing')
})

test.each(['ed_pubkey_hex', 'x_pubkey_hex'] as const)(
  'a mismatch in %s is invalid',
  async (field) => {
    const backend = machine()
    backend.identity.preload(a.keys, a.record)
    const record = { ...a.record, [field]: b.record[field] }
    await expect(
      backend.invoke('identity_keys_status', { record })
    ).resolves.toBe('invalid')
  }
)

test('a partial restore with new keys and the old public file reports invalid', async () => {
  const backend = machine()
  backend.identity.preload(a.keys, a.record)
  backend.identity.saveKeys(b.keys.edPrivHex, b.keys.xPrivHex, true)
  const record = await backend.invoke('identity_load_record', {})
  await expect(
    backend.invoke('identity_keys_status', { record })
  ).resolves.toBe('invalid')
})

test.each([
  { ed_pubkey_hex: 'zz' },
  { ed_pubkey_hex: '00'.repeat(31) },
  { x_pubkey_hex: 'a' },
  { x_pubkey_hex: '00'.repeat(33) },
])('malformed public keys report invalid without throwing', async (keys) => {
  const backend = machine()
  backend.identity.preload(a.keys, a.record)
  await expect(
    backend.invoke('identity_keys_status', { record: { ...a.record, ...keys } })
  ).resolves.toBe('invalid')
})

test.each([
  { edPrivHex: 'zz', xPrivHex: a.keys.xPrivHex },
  { edPrivHex: '00'.repeat(31), xPrivHex: a.keys.xPrivHex },
  { edPrivHex: a.keys.edPrivHex, xPrivHex: 'a' },
  { edPrivHex: a.keys.edPrivHex, xPrivHex: '00'.repeat(33) },
])('malformed protected keys report invalid without throwing', async (keys) => {
  const backend = machine()
  backend.identity.preload(keys, a.record)
  await expect(
    backend.invoke('identity_keys_status', { record: a.record })
  ).resolves.toBe('invalid')
})
