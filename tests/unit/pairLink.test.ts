import { describe, expect, test } from 'vitest'

import {
  decodePairLink,
  encodePairLink,
  generatePairingCode,
} from '@/features/friends'

describe('encodePairLink / decodePairLink', () => {
  test('round-trips a freshly generated pairing code', () => {
    const words = generatePairingCode()
    const link = encodePairLink(words)
    expect(link.startsWith('studyvis://pair?c=')).toBe(true)
    expect(decodePairLink(link)).toEqual(words)
  })

  test('tolerates surrounding whitespace', () => {
    const words = generatePairingCode()
    expect(decodePairLink(`\n  ${encodePairLink(words)}  \n`)).toEqual(words)
  })

  test('stops at a trailing fragment / extra param', () => {
    const words = generatePairingCode()
    expect(decodePairLink(`${encodePairLink(words)}&x=1`)).toEqual(words)
  })

  test('returns null for text that is not a pair link', () => {
    expect(decodePairLink('just twelve random words pasted here')).toBeNull()
    expect(decodePairLink('https://example.com?c=abandon-ability')).toBeNull()
    expect(decodePairLink('')).toBeNull()
  })

  test('returns null when the code has the wrong word count', () => {
    expect(decodePairLink('studyvis://pair?c=abandon-ability-able')).toBeNull()
  })

  test('returns null when a token is not a BIP39 word', () => {
    const words = generatePairingCode()
    const bad = [...words]
    bad[0] = 'zzzzz'
    expect(decodePairLink(`studyvis://pair?c=${bad.join('-')}`)).toBeNull()
  })
})
