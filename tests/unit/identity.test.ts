import { describe, expect, test } from 'vitest'

import {
  boxDecrypt,
  boxEncrypt,
  bytesToHex,
  deriveFromMnemonic,
  generateIdentity,
  hexToBytes,
  mnemonicFingerprint,
  signMessage,
  verifyMessage,
  MNEMONIC_WORD_COUNT,
} from '@/lib/crypto/identity'

describe('generateIdentity', () => {
  test('returns 24-word mnemonic and 32-byte keys', () => {
    const id = generateIdentity()
    expect(id.mnemonic).toHaveLength(MNEMONIC_WORD_COUNT)
    expect(id.edPub).toBeInstanceOf(Uint8Array)
    expect(id.edPub.length).toBe(32)
    expect(id.edPriv).toBeInstanceOf(Uint8Array)
    expect(id.edPriv.length).toBe(32)
    expect(id.xPub).toBeInstanceOf(Uint8Array)
    expect(id.xPub.length).toBe(32)
    expect(id.xPriv).toBeInstanceOf(Uint8Array)
    expect(id.xPriv.length).toBe(32)
  })

  test('every word is from the BIP39 English wordlist', () => {
    const id = generateIdentity()
    for (const w of id.mnemonic) {
      expect(typeof w).toBe('string')
      expect(w.length).toBeGreaterThan(0)
      expect(w).toMatch(/^[a-z]+$/)
    }
  })

  test('two calls produce different identities', () => {
    const a = generateIdentity()
    const b = generateIdentity()
    expect(bytesToHex(a.edPub)).not.toBe(bytesToHex(b.edPub))
    expect(a.mnemonic.join(' ')).not.toBe(b.mnemonic.join(' '))
  })
})

describe('deriveFromMnemonic', () => {
  test('round-trips: generate → derive yields identical keys', () => {
    const id = generateIdentity()
    const derived = deriveFromMnemonic(id.mnemonic)
    expect(bytesToHex(derived.edPub)).toBe(bytesToHex(id.edPub))
    expect(bytesToHex(derived.edPriv)).toBe(bytesToHex(id.edPriv))
    expect(bytesToHex(derived.xPub)).toBe(bytesToHex(id.xPub))
    expect(bytesToHex(derived.xPriv)).toBe(bytesToHex(id.xPriv))
  })

  test('rejects mnemonics of wrong length', () => {
    expect(() => deriveFromMnemonic(['too', 'short'])).toThrow()
  })

  test('rejects checksum-invalid mnemonic', () => {
    const bad = new Array(24).fill('abandon')
    expect(() => deriveFromMnemonic(bad)).toThrow(/invalid BIP39 mnemonic/)
  })
})

describe('signMessage / verifyMessage', () => {
  test('verify true on round-trip', () => {
    const id = generateIdentity()
    const message = new TextEncoder().encode('hello, friends')
    const sig = signMessage(id.edPriv, message)
    expect(sig).toBeInstanceOf(Uint8Array)
    expect(sig.length).toBe(64)
    expect(verifyMessage(id.edPub, message, sig)).toBe(true)
  })

  test('verify false on tampered message', () => {
    const id = generateIdentity()
    const message = new TextEncoder().encode('hello, friends')
    const sig = signMessage(id.edPriv, message)
    const tampered = new TextEncoder().encode('hello, foes!!!')
    expect(verifyMessage(id.edPub, tampered, sig)).toBe(false)
  })

  test('verify false on tampered signature', () => {
    const id = generateIdentity()
    const message = new TextEncoder().encode('hello')
    const sig = signMessage(id.edPriv, message)
    const tampered = new Uint8Array(sig)
    tampered[0] ^= 0x01
    expect(verifyMessage(id.edPub, message, tampered)).toBe(false)
  })

  test('verify false against the wrong public key', () => {
    const a = generateIdentity()
    const b = generateIdentity()
    const message = new TextEncoder().encode('hello')
    const sig = signMessage(a.edPriv, message)
    expect(verifyMessage(b.edPub, message, sig)).toBe(false)
  })
})

describe('boxEncrypt / boxDecrypt', () => {
  test('round-trips between two distinct keypairs', () => {
    const sender = generateIdentity()
    const recipient = generateIdentity()
    const plaintext = new TextEncoder().encode('an invite envelope')
    const { nonce, ciphertext } = boxEncrypt(
      recipient.xPub,
      sender.xPriv,
      plaintext
    )
    expect(nonce.length).toBe(24)
    expect(ciphertext.length).toBeGreaterThan(plaintext.length)
    const decrypted = boxDecrypt(
      sender.xPub,
      recipient.xPriv,
      nonce,
      ciphertext
    )
    expect(new TextDecoder().decode(decrypted)).toBe('an invite envelope')
  })

  test('decrypt throws when ciphertext is tampered', () => {
    const sender = generateIdentity()
    const recipient = generateIdentity()
    const plaintext = new TextEncoder().encode('an invite envelope')
    const { nonce, ciphertext } = boxEncrypt(
      recipient.xPub,
      sender.xPriv,
      plaintext
    )
    const tampered = new Uint8Array(ciphertext)
    tampered[tampered.length - 1] ^= 0x01
    expect(() =>
      boxDecrypt(sender.xPub, recipient.xPriv, nonce, tampered)
    ).toThrow()
  })

  test('decrypt throws when nonce is tampered', () => {
    const sender = generateIdentity()
    const recipient = generateIdentity()
    const plaintext = new TextEncoder().encode('an invite envelope')
    const { nonce, ciphertext } = boxEncrypt(
      recipient.xPub,
      sender.xPriv,
      plaintext
    )
    const wrongNonce = new Uint8Array(nonce)
    wrongNonce[0] ^= 0x01
    expect(() =>
      boxDecrypt(sender.xPub, recipient.xPriv, wrongNonce, ciphertext)
    ).toThrow()
  })

  test('decrypt fails when an attacker substitutes a different sender pubkey', () => {
    const sender = generateIdentity()
    const recipient = generateIdentity()
    const stranger = generateIdentity()
    const plaintext = new TextEncoder().encode('an invite envelope')
    const { nonce, ciphertext } = boxEncrypt(
      recipient.xPub,
      sender.xPriv,
      plaintext
    )
    expect(() =>
      boxDecrypt(stranger.xPub, recipient.xPriv, nonce, ciphertext)
    ).toThrow()
  })
})

describe('HKDF derivation properties', () => {
  test('same mnemonic always yields the same keys (determinism)', () => {
    const id = generateIdentity()
    const a = deriveFromMnemonic(id.mnemonic)
    const b = deriveFromMnemonic(id.mnemonic)
    expect(bytesToHex(a.edPriv)).toBe(bytesToHex(b.edPriv))
    expect(bytesToHex(a.edPub)).toBe(bytesToHex(b.edPub))
    expect(bytesToHex(a.xPriv)).toBe(bytesToHex(b.xPriv))
    expect(bytesToHex(a.xPub)).toBe(bytesToHex(b.xPub))
  })

  test('ed_priv and x_priv are independent (different info strings)', () => {
    const id = generateIdentity()
    expect(bytesToHex(id.edPriv)).not.toBe(bytesToHex(id.xPriv))
  })

  test('neither private key equals the BIP39 master seed prefix', async () => {
    const { mnemonicToSeedSync } = await import('@scure/bip39')
    const id = generateIdentity()
    const seed = mnemonicToSeedSync(id.mnemonic.join(' '), '')
    const seedHead32 = seed.slice(0, 32)
    expect(bytesToHex(id.edPriv)).not.toBe(bytesToHex(seedHead32))
    expect(bytesToHex(id.xPriv)).not.toBe(bytesToHex(seedHead32))
  })

  test('different mnemonics yield different keys', () => {
    const a = generateIdentity()
    const b = generateIdentity()
    expect(bytesToHex(a.edPriv)).not.toBe(bytesToHex(b.edPriv))
    expect(bytesToHex(a.xPriv)).not.toBe(bytesToHex(b.xPriv))
  })
})

describe('mnemonicFingerprint', () => {
  test('is deterministic and 32 hex chars (16 bytes)', () => {
    const m = ['ocean', 'ladder', 'cinnamon'] as const
    const a = mnemonicFingerprint(m as unknown as string[])
    const b = mnemonicFingerprint(m as unknown as string[])
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{32}$/)
  })

  test('different mnemonics produce different fingerprints', () => {
    expect(mnemonicFingerprint(['a', 'b', 'c'])).not.toBe(
      mnemonicFingerprint(['a', 'b', 'd'])
    )
  })
})

describe('hex utilities', () => {
  test('bytesToHex / hexToBytes round-trip', () => {
    const b = new Uint8Array([0, 1, 15, 16, 255])
    expect(bytesToHex(b)).toBe('00010f10ff')
    const back = hexToBytes('00010f10ff')
    expect(Array.from(back)).toEqual([0, 1, 15, 16, 255])
  })

  test('hexToBytes rejects odd-length input', () => {
    expect(() => hexToBytes('abc')).toThrow()
  })
})
