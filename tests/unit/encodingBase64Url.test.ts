import { describe, expect, test } from 'vitest'

import {
  base64ToBytes,
  base64UrlToBytes,
  bytesToBase64,
  bytesToBase64Url,
} from '@/lib/encoding'

// Deterministic pseudo-random bytes (no Math.random in this harness).
function seeded(len: number, seed: number): Uint8Array {
  const out = new Uint8Array(len)
  let s = seed >>> 0
  for (let i = 0; i < len; i++) {
    s = (s * 1664525 + 1013904223) >>> 0
    out[i] = s & 0xff
  }
  return out
}

describe('base64url helpers', () => {
  test('round-trips buffers of card-ish lengths', () => {
    for (let len = 130; len <= 178; len++) {
      const bytes = seeded(len, len * 7 + 1)
      const enc = bytesToBase64Url(bytes)
      expect(enc).toMatch(/^[A-Za-z0-9_-]+$/)
      expect(enc).not.toContain('=')
      expect(enc).not.toContain('+')
      expect(enc).not.toContain('/')
      const dec = base64UrlToBytes(enc)
      expect(dec).not.toBeNull()
      expect(Array.from(dec!)).toEqual(Array.from(bytes))
    }
  })

  test('base64url of a known buffer matches standard base64 sans +/=', () => {
    const bytes = new Uint8Array([0xfb, 0xff, 0xbf, 0x00])
    const std = bytesToBase64(bytes) // contains + and / and =
    const url = bytesToBase64Url(bytes)
    expect(url).toBe(
      std.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    )
    expect(Array.from(base64UrlToBytes(url)!)).toEqual(Array.from(bytes))
  })

  test('strips internal whitespace before decoding', () => {
    const bytes = seeded(48, 3)
    const enc = bytesToBase64Url(bytes)
    const wrapped =
      enc.slice(0, 20) + '\n' + enc.slice(20, 40) + ' ' + enc.slice(40)
    expect(Array.from(base64UrlToBytes(wrapped)!)).toEqual(Array.from(bytes))
  })

  test('rejects standard-base64 chars (+ / =) rather than mis-decoding', () => {
    expect(base64UrlToBytes('ab+c')).toBeNull()
    expect(base64UrlToBytes('ab/c')).toBeNull()
    expect(base64UrlToBytes('abc=')).toBeNull()
  })

  test('rejects empty, len%4===1, and non-alphabet input', () => {
    expect(base64UrlToBytes('')).toBeNull()
    expect(base64UrlToBytes('AAAAA')).toBeNull() // 5 chars → %4 === 1
    expect(base64UrlToBytes('hello world!')).toBeNull()
  })

  test('standard base64 helpers are unchanged', () => {
    const bytes = seeded(30, 99)
    expect(Array.from(base64ToBytes(bytesToBase64(bytes)))).toEqual(
      Array.from(bytes)
    )
  })
})
