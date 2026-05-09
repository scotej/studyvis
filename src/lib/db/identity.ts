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
