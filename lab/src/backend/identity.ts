// Identity custody for a lab machine.
//
// The real commands keep the Ed25519 + X25519 private keys in the OS keychain
// (service `com.studyvis.app`, user `identity-keys`) and expose only
// sign / box-encrypt / box-decrypt to JS. The lab keeps them in memory for the
// life of the peer and NEVER opens a keyring: this Mac has a real StudyVis
// install whose single keychain entry a lab run must not be able to read,
// overwrite or delete. That isolation is an invariant, not an optimization —
// `lab doctor` asserts no keyring module is even reachable from here.
//
// The crypto itself is the app's own module (`src/lib/crypto/identity.ts`),
// which a pinned libsodium vector proves byte-compatible with the Rust side.
// So a lab peer's signatures and sealed envelopes are the real ones.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { boxDecrypt, boxEncrypt, signMessage } from '@/lib/crypto/identity'

export type IdentityRecord = {
  version: number
  ed_pubkey_hex: string
  x_pubkey_hex: string
  display_name: string
  created_at: number
  mnemonic_fingerprint: string
}

type StoredKeys = { edPrivHex: string; xPrivHex: string }

function hexToBytes(hex: string): Uint8Array {
  // parseInt would turn a non-hex pair into NaN and then into a zero byte, so
  // a malformed key would silently become a valid-looking one.
  if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length % 2 !== 0) {
    throw new Error('invalid hex')
  }
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

export class LabIdentity {
  private keys: StoredKeys | null = null
  private readonly recordPath: string

  constructor(dir: string) {
    this.recordPath = path.join(dir, 'identity.json')
  }

  /** Seed a peer with a ready-made identity, skipping the onboarding UI. */
  preload(keys: StoredKeys, record: IdentityRecord): void {
    this.keys = keys
    writeFileSync(this.recordPath, JSON.stringify(record, null, 2), {
      mode: 0o600,
    })
  }

  exists(): boolean {
    return existsSync(this.recordPath)
  }

  // The real probe is false only on a definitive keyring NoEntry; an ambiguous
  // keyring failure rejects so callers don't steer into recovery (#47 E1).
  // In the lab the answer is never ambiguous.
  keysPresent(): boolean {
    return this.keys !== null
  }

  loadRecord(): IdentityRecord | null {
    if (!existsSync(this.recordPath)) return null
    return JSON.parse(readFileSync(this.recordPath, 'utf8')) as IdentityRecord
  }

  saveRecord(record: IdentityRecord): void {
    writeFileSync(this.recordPath, JSON.stringify(record, null, 2), {
      mode: 0o600,
    })
  }

  saveKeys(edPrivHex: string, xPrivHex: string, overwrite: boolean): void {
    if (this.keys && !overwrite) {
      const same =
        this.keys.edPrivHex === edPrivHex && this.keys.xPrivHex === xPrivHex
      // Idempotent retries are accepted; a genuinely different key needs the
      // confirmed-recovery overwrite flag, exactly as Rust does.
      if (!same) throw new Error('identity keys already present')
      return
    }
    this.keys = { edPrivHex, xPrivHex }
  }

  sign(message: number[]): number[] {
    const keys = this.require()
    return Array.from(
      signMessage(hexToBytes(keys.edPrivHex), Uint8Array.from(message))
    )
  }

  boxEncrypt(
    theirXPubHex: string,
    plaintext: number[]
  ): { nonce_b64: string; ciphertext_b64: string } {
    const keys = this.require()
    const { nonce, ciphertext } = boxEncrypt(
      hexToBytes(theirXPubHex),
      hexToBytes(keys.xPrivHex),
      Uint8Array.from(plaintext)
    )
    return {
      nonce_b64: Buffer.from(nonce).toString('base64'),
      ciphertext_b64: Buffer.from(ciphertext).toString('base64'),
    }
  }

  boxDecrypt(
    theirXPubHex: string,
    nonceB64: string,
    ciphertextB64: string
  ): number[] {
    const keys = this.require()
    try {
      return Array.from(
        boxDecrypt(
          hexToBytes(theirXPubHex),
          hexToBytes(keys.xPrivHex),
          new Uint8Array(Buffer.from(nonceB64, 'base64')),
          new Uint8Array(Buffer.from(ciphertextB64, 'base64'))
        )
      )
    } catch {
      // Deliberately unspecific, matching src-tauri/src/crypto.rs.
      throw new Error('decrypt failed')
    }
  }

  private require(): StoredKeys {
    if (!this.keys) throw new Error('read keyring: No matching entry found')
    return this.keys
  }
}
