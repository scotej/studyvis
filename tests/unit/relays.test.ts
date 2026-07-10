import { describe, expect, test } from 'vitest'

import { DEFAULT_RELAY_URLS, mergedRelayUrls } from '@/lib/trystero/relays'

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

// #47 A5 — custom relays must EXTEND the curated pin, never replace it, or
// one friend adding a self-hosted relay silently severs discovery with every
// friend on the defaults.
describe('mergedRelayUrls', () => {
  test('unions custom relays (first) with every default', () => {
    const custom = ['wss://self-hosted.example']
    const merged = mergedRelayUrls(custom)
    expect(merged[0]).toBe('wss://self-hosted.example')
    for (const url of DEFAULT_RELAY_URLS) {
      expect(merged).toContain(url)
    }
    expect(merged).toHaveLength(custom.length + DEFAULT_RELAY_URLS.length)
  })

  test('dedupes a custom entry that is already a default', () => {
    const merged = mergedRelayUrls([DEFAULT_RELAY_URLS[0]])
    expect(merged).toEqual(DEFAULT_RELAY_URLS)
  })
})
