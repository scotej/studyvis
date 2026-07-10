// Typed wrappers over the Rust `identity_*` commands. `IdentityRecord` is the
// on-disk identity.json schema (snake_case; renaming a field breaks load).
// The `*WithKeyring` functions are the KEYCHAIN twin of the pure crypto in
// @/lib/crypto/identity.ts: same byte formats, but the private key never
// enters JS — Rust reads it from the OS keychain. Post-onboarding code should
// use these; the pure variants exist for derivation-time use, when the
// mnemonic (and thus the keys) are legitimately in memory.

import { invoke } from '@tauri-apps/api/core'

import { base64ToBytes, bytesToBase64, bytesToHex } from '@/lib/encoding'

export const IDENTITY_VERSION = 1 as const

export type IdentityRecord = {
  version: typeof IDENTITY_VERSION
  ed_pubkey_hex: string
  x_pubkey_hex: string
  display_name: string
  created_at: number
  mnemonic_fingerprint: string
}

export async function identityExists(): Promise<boolean> {
  return invoke<boolean>('identity_exists')
}

// #47 E1 — does the OS keychain hold the private keys identity.json claims
// to describe? False only on a definitive keyring NoEntry; ambiguous keyring
// failures (locked keychain, access denied) reject instead, and callers
// treat the probe as inconclusive rather than steering into recovery.
export async function identityKeysPresent(): Promise<boolean> {
  return invoke<boolean>('identity_keys_present')
}

export async function loadIdentityRecord(): Promise<IdentityRecord | null> {
  return invoke<IdentityRecord | null>('identity_load_record')
}

export async function saveIdentityRecord(
  record: IdentityRecord
): Promise<void> {
  await invoke('identity_save_record', { record })
}

export async function saveKeys(
  edPrivHex: string,
  xPrivHex: string,
  overwrite: boolean
): Promise<void> {
  await invoke('identity_save_keys', { edPrivHex, xPrivHex, overwrite })
}

export async function signWithKeyring(
  message: Uint8Array
): Promise<Uint8Array> {
  const sig = await invoke<number[]>('identity_sign', {
    message: Array.from(message),
  })
  return new Uint8Array(sig)
}

export async function boxDecryptWithKeyring(
  theirXPub: Uint8Array,
  nonce: Uint8Array,
  ciphertext: Uint8Array
): Promise<Uint8Array> {
  const plaintext = await invoke<number[]>('identity_box_decrypt', {
    theirXPubHex: bytesToHex(theirXPub),
    nonceB64: bytesToBase64(nonce),
    ciphertextB64: bytesToBase64(ciphertext),
  })
  return new Uint8Array(plaintext)
}

export async function boxEncryptWithKeyring(
  theirXPub: Uint8Array,
  plaintext: Uint8Array
): Promise<{ nonce: Uint8Array; ciphertext: Uint8Array }> {
  const result = await invoke<{ nonce_b64: string; ciphertext_b64: string }>(
    'identity_box_encrypt',
    {
      theirXPubHex: bytesToHex(theirXPub),
      plaintext: Array.from(plaintext),
    }
  )
  return {
    nonce: base64ToBytes(result.nonce_b64),
    ciphertext: base64ToBytes(result.ciphertext_b64),
  }
}
