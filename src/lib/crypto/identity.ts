import * as ed from '@noble/ed25519'
import { x25519 } from '@noble/curves/ed25519.js'
import { xsalsa20poly1305, hsalsa } from '@noble/ciphers/salsa.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { sha512 } from '@noble/hashes/sha2.js'
import {
  generateMnemonic,
  mnemonicToSeedSync,
  validateMnemonic,
} from '@scure/bip39'
import { wordlist as englishWordlist } from '@scure/bip39/wordlists/english.js'

ed.hashes.sha512 = sha512

const HKDF_SALT = new TextEncoder().encode('studyvis')
const HKDF_INFO_ED = new TextEncoder().encode('ed25519:v1')
const HKDF_INFO_X = new TextEncoder().encode('x25519:v1')

export const MNEMONIC_WORD_COUNT = 24
const MNEMONIC_STRENGTH_BITS = 256

export type Mnemonic = string[]

export type Identity = {
  mnemonic: Mnemonic
  edPub: Uint8Array
  edPriv: Uint8Array
  xPub: Uint8Array
  xPriv: Uint8Array
}

export type Keys = Omit<Identity, 'mnemonic'>

export type BoxOutput = {
  nonce: Uint8Array
  ciphertext: Uint8Array
}

export function generateIdentity(): Identity {
  const phrase = generateMnemonic(englishWordlist, MNEMONIC_STRENGTH_BITS)
  const mnemonic = phrase.split(' ')
  const keys = deriveFromMnemonic(mnemonic)
  return { mnemonic, ...keys }
}

export function deriveFromMnemonic(mnemonic: Mnemonic): Keys {
  if (mnemonic.length !== MNEMONIC_WORD_COUNT) {
    throw new Error(`mnemonic must be ${MNEMONIC_WORD_COUNT} words`)
  }
  const phrase = mnemonic.join(' ')
  if (!validateMnemonic(phrase, englishWordlist)) {
    throw new Error('invalid BIP39 mnemonic (checksum or wordlist mismatch)')
  }
  const masterSeed = mnemonicToSeedSync(phrase, '')
  const edPriv = hkdf(sha256, masterSeed, HKDF_SALT, HKDF_INFO_ED, 32)
  const xPriv = hkdf(sha256, masterSeed, HKDF_SALT, HKDF_INFO_X, 32)
  const edPub = ed.getPublicKey(edPriv)
  const xPub = x25519.getPublicKey(xPriv)
  return { edPub, edPriv, xPub, xPriv }
}

export function signMessage(
  edPriv: Uint8Array,
  message: Uint8Array
): Uint8Array {
  return ed.sign(message, edPriv)
}

export function verifyMessage(
  edPub: Uint8Array,
  message: Uint8Array,
  sig: Uint8Array
): boolean {
  try {
    return ed.verify(sig, message, edPub)
  } catch {
    return false
  }
}

const SIGMA = new Uint32Array([0x61707865, 0x3320646e, 0x79622d32, 0x6b206574])

function bytesToU32LE(bytes: Uint8Array, count: number): Uint32Array {
  const out = new Uint32Array(count)
  const dv = new DataView(bytes.buffer, bytes.byteOffset, count * 4)
  for (let i = 0; i < count; i++) out[i] = dv.getUint32(i * 4, true)
  return out
}

function u32LEToBytes(words: Uint32Array): Uint8Array {
  const out = new Uint8Array(words.length * 4)
  const dv = new DataView(out.buffer)
  for (let i = 0; i < words.length; i++) dv.setUint32(i * 4, words[i], true)
  return out
}

function naclBoxKey(theirXPub: Uint8Array, myXPriv: Uint8Array): Uint8Array {
  const shared = x25519.getSharedSecret(myXPriv, theirXPub)
  const ZERO16 = new Uint8Array(16)
  const k = bytesToU32LE(shared, 8)
  const i = bytesToU32LE(ZERO16, 4)
  const out = new Uint32Array(8)
  hsalsa(SIGMA, k, i, out)
  return u32LEToBytes(out)
}

function randomNonce24(): Uint8Array {
  const n = new Uint8Array(24)
  crypto.getRandomValues(n)
  return n
}

export function boxEncrypt(
  theirXPub: Uint8Array,
  myXPriv: Uint8Array,
  plaintext: Uint8Array
): BoxOutput {
  const key = naclBoxKey(theirXPub, myXPriv)
  const nonce = randomNonce24()
  const ciphertext = xsalsa20poly1305(key, nonce).encrypt(plaintext)
  return { nonce, ciphertext }
}

export function boxDecrypt(
  theirXPub: Uint8Array,
  myXPriv: Uint8Array,
  nonce: Uint8Array,
  ciphertext: Uint8Array
): Uint8Array {
  const key = naclBoxKey(theirXPub, myXPriv)
  return xsalsa20poly1305(key, nonce).decrypt(ciphertext)
}

export function mnemonicFingerprint(mnemonic: Mnemonic): string {
  const phrase = mnemonic.join(' ')
  const digest = sha256(new TextEncoder().encode(phrase))
  let out = ''
  for (let i = 0; i < 16; i++) out += digest[i].toString(16).padStart(2, '0')
  return out
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i++)
    out += bytes[i].toString(16).padStart(2, '0')
  return out
}

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('hex must be even-length')
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) {
    const byte = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
    if (Number.isNaN(byte)) throw new Error('invalid hex')
    out[i] = byte
  }
  return out
}
