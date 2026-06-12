// X4 — semver-ish version comparison for the opt-in update check.

import { describe, expect, test } from 'vitest'

import { isNewerVersion } from '@/lib/version'

describe('isNewerVersion', () => {
  test('detects a strictly newer candidate in each segment', () => {
    expect(isNewerVersion('1.2.0', '1.2.1')).toBe(true)
    expect(isNewerVersion('1.2.0', '1.3.0')).toBe(true)
    expect(isNewerVersion('1.2.0', '2.0.0')).toBe(true)
    expect(isNewerVersion('1.9.9', '1.10.0')).toBe(true)
  })

  test('returns false for equal or older candidates', () => {
    expect(isNewerVersion('1.2.0', '1.2.0')).toBe(false)
    expect(isNewerVersion('1.2.1', '1.2.0')).toBe(false)
    expect(isNewerVersion('2.0.0', '1.9.9')).toBe(false)
  })

  test('tolerates a leading v and a pre-release suffix on the candidate', () => {
    expect(isNewerVersion('1.2.0', 'v1.3.0')).toBe(true)
    expect(isNewerVersion('1.2.0', '1.3.0-rc1')).toBe(true)
    expect(isNewerVersion('1.2.0', '1.2.0-rc1')).toBe(false)
  })

  test('treats short versions as zero-padded', () => {
    expect(isNewerVersion('1.2', '1.2.1')).toBe(true)
    expect(isNewerVersion('1', '1.0.1')).toBe(true)
    expect(isNewerVersion('1.0.0', '1')).toBe(false)
  })

  test('returns false for any unparseable input (no phantom updates)', () => {
    expect(isNewerVersion('1.2.0', 'not-a-version')).toBe(false)
    expect(isNewerVersion('garbage', '2.0.0')).toBe(false)
    expect(isNewerVersion('1.2.0', '1.2.x')).toBe(false)
    expect(isNewerVersion('1.2.0', '1.2.3.4')).toBe(false)
  })
})
