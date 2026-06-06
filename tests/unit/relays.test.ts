import { describe, expect, test } from 'vitest'

import { DEFAULT_RELAY_URLS } from '@/lib/trystero/relays'

describe('DEFAULT_RELAY_URLS', () => {
  test('is a non-empty list of secure wss:// relay URLs', () => {
    expect(DEFAULT_RELAY_URLS.length).toBeGreaterThan(0)
    for (const url of DEFAULT_RELAY_URLS) {
      expect(url.startsWith('wss://')).toBe(true)
    }
  })

  test('has no duplicate entries', () => {
    expect(new Set(DEFAULT_RELAY_URLS).size).toBe(DEFAULT_RELAY_URLS.length)
  })
})
