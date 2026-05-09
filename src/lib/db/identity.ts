import { invoke } from '@tauri-apps/api/core'

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
  xPrivHex: string
): Promise<void> {
  await invoke('identity_save_keys', { edPrivHex, xPrivHex })
}

export async function signWithKeyring(
  message: Uint8Array
): Promise<Uint8Array> {
  const sig = await invoke<number[]>('identity_sign', {
    message: Array.from(message),
  })
  return new Uint8Array(sig)
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}

function bytesToHex(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i++)
    out += bytes[i].toString(16).padStart(2, '0')
  return out
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

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
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
