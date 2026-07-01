import { describe, expect, test } from 'vitest'

import { pairFingerprint, shortEdFingerprint } from '@/lib/crypto/topics'

const A = '11'.repeat(32)
const B = '22'.repeat(32)

describe('pairFingerprint', () => {
  test('is symmetric in its two inputs', () => {
    expect(pairFingerprint(A, B)).toBe(pairFingerprint(B, A))
  })

  test('renders as four groups of five digits', () => {
    expect(pairFingerprint(A, B)).toMatch(/^\d{5} \d{5} \d{5} \d{5}$/)
  })

  test('is stable for the same pair (pinned regression vector)', () => {
    // Pins the exact digest→digits mapping so a future refactor can't silently
    // change what two already-paired friends compare.
    expect(pairFingerprint(A, B)).toBe('12269 50637 32695 35478')
  })

  test('changes when either key changes', () => {
    const C = '22'.repeat(31) + '23'
    expect(pairFingerprint(A, C)).not.toBe(pairFingerprint(A, B))
  })

  test('is independent of name/x — only ed keys feed it', () => {
    // Same eds always yield the same fingerprint (there is no other input).
    expect(pairFingerprint(A, B)).toBe(pairFingerprint(A, B))
  })
})

describe('shortEdFingerprint', () => {
  test('is a stable lowercase 8-hex prefix that differs across keys', () => {
    expect(shortEdFingerprint(A)).toBe('11111111')
    expect(shortEdFingerprint('ABCDEF00' + '00'.repeat(28))).toBe('abcdef00')
    expect(shortEdFingerprint(A)).not.toBe(shortEdFingerprint(B))
  })
})
