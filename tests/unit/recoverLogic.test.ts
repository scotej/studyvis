import { describe, expect, test } from 'vitest'

import {
  classifyMnemonic,
  decideOverwrite,
  normalizeMnemonicInput,
} from '@/features/identity/recoverLogic'
import {
  bytesToHex,
  deriveFromMnemonic,
  mnemonicFingerprint,
} from '@/lib/crypto/identity'

// Same Trezor zero-entropy vector locked in identity.test.ts. Recovery must
// land on this exact key no matter how messily the words were typed.
const KNOWN_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon ' +
  'abandon abandon abandon abandon abandon abandon abandon abandon ' +
  'abandon abandon abandon abandon abandon abandon abandon art'
const KNOWN_EDPUB =
  'df9f33f39235012c17f3a534eb0a0693afbe2f31182fb14f3916895c87dc4ce9'

describe('normalizeMnemonicInput', () => {
  test('lowercases, collapses every whitespace run, trims, drops empties', () => {
    expect(normalizeMnemonicInput('  Ocean\tLadder\n\nCINNAMON  ')).toEqual([
      'ocean',
      'ladder',
      'cinnamon',
    ])
  })

  test('empty or whitespace-only input yields no words', () => {
    expect(normalizeMnemonicInput('')).toEqual([])
    expect(normalizeMnemonicInput('   \n\t  ')).toEqual([])
  })
})

describe('classifyMnemonic', () => {
  test('empty input → empty', () => {
    expect(classifyMnemonic('   ').kind).toBe('empty')
  })

  test('fewer than 24 words → short', () => {
    expect(classifyMnemonic('ocean ladder cinnamon').kind).toBe('short')
  })

  test('more than 24 words → long', () => {
    expect(classifyMnemonic(new Array(25).fill('abandon').join(' ')).kind).toBe(
      'long'
    )
  })

  test('24 real words with a bad checksum → invalid, no unknown words', () => {
    const result = classifyMnemonic(new Array(24).fill('abandon').join(' '))
    expect(result.kind).toBe('invalid')
    expect(result.unknownWords).toEqual([])
  })

  test('a single non-wordlist word → invalid, exactly that word flagged', () => {
    const words = new Array(24).fill('abandon')
    words[5] = 'cactas'
    const result = classifyMnemonic(words.join(' '))
    expect(result.kind).toBe('invalid')
    expect(result.unknownWords).toEqual(['cactas'])
  })

  test('a comma-suffixed retype flags every token (plural copy path)', () => {
    const result = classifyMnemonic(new Array(24).fill('abandon,').join(' '))
    expect(result.kind).toBe('invalid')
    expect(result.unknownWords).toHaveLength(24)
  })

  test('a valid 24-word phrase → valid with 24 normalized words', () => {
    const result = classifyMnemonic(KNOWN_MNEMONIC)
    expect(result.kind).toBe('valid')
    expect(result.words).toHaveLength(24)
  })
})

describe('decideOverwrite (D5: same vs different backup)', () => {
  const KNOWN_WORDS = KNOWN_MNEMONIC.split(' ')
  const KNOWN_FP = mnemonicFingerprint(KNOWN_WORDS)
  // decideOverwrite only fingerprints the words (the caller has already
  // validated the phrase), so any distinct 24-word array stands in for a
  // different identity here.
  const OTHER_WORDS = new Array(24).fill('legal')
  const OTHER_FP = mnemonicFingerprint(OTHER_WORDS)

  test('no identity on this device → commit (no warning)', () => {
    expect(decideOverwrite(KNOWN_WORDS, false, null)).toBe('commit')
    expect(decideOverwrite(KNOWN_WORDS, false, KNOWN_FP)).toBe('commit')
  })

  test('same words as the stored fingerprint → commit (harmless re-commit)', () => {
    expect(decideOverwrite(KNOWN_WORDS, true, KNOWN_FP)).toBe('commit')
  })

  test('different words from the stored fingerprint → confirm-different', () => {
    expect(decideOverwrite(KNOWN_WORDS, true, OTHER_FP)).toBe(
      'confirm-different'
    )
  })

  test('identity exists but fingerprint unknown (legacy) → generic confirm', () => {
    expect(decideOverwrite(KNOWN_WORDS, true, null)).toBe('confirm')
    expect(decideOverwrite(KNOWN_WORDS, true, undefined)).toBe('confirm')
    expect(decideOverwrite(KNOWN_WORDS, true, '')).toBe('confirm')
  })

  test('the two reference fingerprints actually differ (guards the fixture)', () => {
    expect(KNOWN_FP).not.toBe(OTHER_FP)
  })
})

describe('recovery normalizes case + whitespace before deriving', () => {
  test('a messy paste of the known mnemonic restores the exact pubkey', () => {
    const messy = `  ABANDON\nabandon\tabandon  abandon abandon abandon abandon abandon
      abandon abandon abandon abandon abandon abandon abandon abandon
      abandon abandon abandon abandon abandon abandon abandon   ART  `
    const classified = classifyMnemonic(messy)
    expect(classified.kind).toBe('valid')
    const keys = deriveFromMnemonic(classified.words)
    expect(bytesToHex(keys.edPub)).toBe(KNOWN_EDPUB)
  })
})
