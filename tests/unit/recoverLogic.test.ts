import { describe, expect, test } from 'vitest'

import {
  classifyMnemonic,
  normalizeMnemonicInput,
} from '@/features/identity/recoverLogic'
import { bytesToHex, deriveFromMnemonic } from '@/lib/crypto/identity'

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

  test('24 words with a bad checksum → invalid', () => {
    expect(classifyMnemonic(new Array(24).fill('abandon').join(' ')).kind).toBe(
      'invalid'
    )
  })

  test('a valid 24-word phrase → valid with 24 normalized words', () => {
    const result = classifyMnemonic(KNOWN_MNEMONIC)
    expect(result.kind).toBe('valid')
    expect(result.words).toHaveLength(24)
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
