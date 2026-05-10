import { describe, expect, test } from 'vitest'

import {
  BIP39_WORDLIST,
  isBip39Word,
  pairWordsAreComplete,
  sanitizePairWordInput,
  tokenizePairWords,
} from '@/features/friends'

describe('BIP39_WORDLIST', () => {
  test('contains exactly 2048 words', () => {
    expect(BIP39_WORDLIST).toHaveLength(2048)
  })
})

describe('isBip39Word', () => {
  test('accepts canonical wordlist entries', () => {
    expect(isBip39Word('abandon')).toBe(true)
    expect(isBip39Word('zoo')).toBe(true)
  })

  test('lowercases input before checking', () => {
    expect(isBip39Word('ABANDON')).toBe(true)
    expect(isBip39Word('Zoo')).toBe(true)
  })

  test('rejects non-list words', () => {
    expect(isBip39Word('zzzzz')).toBe(false)
    expect(isBip39Word('hello1')).toBe(false)
    expect(isBip39Word('')).toBe(false)
  })
})

describe('sanitizePairWordInput', () => {
  test('strips characters outside [a-z]', () => {
    expect(sanitizePairWordInput('aB-c 1d!')).toBe('abcd')
  })

  test('clamps to 8 characters (the longest BIP39 word)', () => {
    expect(sanitizePairWordInput('abcdefghijklmnop')).toBe('abcdefgh')
  })

  test('returns empty for purely-invalid input', () => {
    expect(sanitizePairWordInput('123 -- !')).toBe('')
  })
})

describe('tokenizePairWords', () => {
  test('splits on whitespace and lowercases', () => {
    expect(tokenizePairWords('  Word1\nWord2\tword3  ')).toEqual([
      'word',
      'word',
      'word',
    ])
  })

  test('drops empty tokens', () => {
    expect(tokenizePairWords('a   b\n\nc')).toEqual(['a', 'b', 'c'])
  })

  test('strips non-letters from each token', () => {
    expect(tokenizePairWords('abandon!! ABLE--ABOVE')).toEqual([
      'abandon',
      'ableabove',
    ])
    // ABLE--ABOVE collapses into a single token after the dashes are
    // stripped — fine for our use, since the per-input sanitizer in
    // PairWordInput re-clamps to 8 chars and any malformed token is rejected
    // by isBip39Word.
  })
})

describe('pairWordsAreComplete', () => {
  test('true when every slot is in the wordlist', () => {
    expect(pairWordsAreComplete(['abandon', 'ability', 'able'], 3)).toBe(true)
  })

  test('false when length mismatches', () => {
    expect(pairWordsAreComplete(['abandon'], 12)).toBe(false)
  })

  test('false when any slot is empty or invalid', () => {
    expect(pairWordsAreComplete(['abandon', '', 'able'], 3)).toBe(false)
    expect(pairWordsAreComplete(['abandon', 'zzzzz', 'able'], 3)).toBe(false)
  })
})
