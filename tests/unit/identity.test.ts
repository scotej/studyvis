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

  test('decrypts a libsodium crypto_box_easy vector byte-for-byte', () => {
    // Vector generated with pynacl (libsodium binding) using RFC 7748 §6.1
    // X25519 reference scalars. Locks our @noble/ciphers + HSalsa20 construction
    // to libsodium's crypto_box_easy output format ([poly1305_tag(16) || ciphertext]).
    // Sender = Alice, recipient = Bob.
    const aliceXPub = hexToBytes(
      '8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a'
    )
    const bobXPriv = hexToBytes(
      '5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb'
    )
    const nonce = hexToBytes('69696ee955b62b73cd62bda875fc73d68219e0036b7a0b37')
    const ciphertext = hexToBytes(
      '7e5c50f10331000e8b4f7019d8eb46f443ea113e0d9f89d520eb2ddab0631f986c7e88f9355d'
    )
    const expected = new TextEncoder().encode('studyvis-invite-vector')
    const decrypted = boxDecrypt(aliceXPub, bobXPriv, nonce, ciphertext)
    expect(Array.from(decrypted)).toEqual(Array.from(expected))
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
