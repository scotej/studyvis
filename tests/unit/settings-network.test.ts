import { describe, expect, test } from 'vitest'

import {
  isValidRelayUrl,
  isValidTurnUrl,
  normalizeTurnServer,
  parseRelayUrls,
} from '@/stores/settingsStore'

describe('F3 relay URL validation', () => {
  test('accepts wss:// URLs only', () => {
    expect(isValidRelayUrl('wss://relay.example.com')).toBe(true)
    expect(isValidRelayUrl('WSS://relay.example.com')).toBe(true)
    expect(isValidRelayUrl('wss://relay.example.com:443/path')).toBe(true)
    expect(isValidRelayUrl('ws://relay.example.com')).toBe(false)
    expect(isValidRelayUrl('https://relay.example.com')).toBe(false)
    expect(isValidRelayUrl('relay.example.com')).toBe(false)
    expect(isValidRelayUrl('')).toBe(false)
    expect(isValidRelayUrl(42)).toBe(false)
  })

  test('rejects malformed URLs that new WebSocket() would throw on', () => {
    // These pass a naive /^wss:\/\/\S+$/ regex but break the WebSocket
    // constructor synchronously — a saved one would blank the app at boot.
    expect(isValidRelayUrl('wss://[bad')).toBe(false) // unparseable host
    expect(isValidRelayUrl('wss://#x')).toBe(false) // no host, fragment only
    expect(isValidRelayUrl('wss://host/#frag')).toBe(false) // WS forbids a fragment
    expect(isValidRelayUrl('wss://host#frag')).toBe(false)
  })

  test('parseRelayUrls drops invalid lines, trims, and dedupes', () => {
    const text = [
      'wss://a.example',
      '  wss://b.example  ',
      'ws://insecure.example',
      'not a url',
      '',
      'wss://a.example', // duplicate
    ].join('\n')
    expect(parseRelayUrls(text)).toEqual(['wss://a.example', 'wss://b.example'])
  })

  test('parseRelayUrls returns [] for all-invalid input', () => {
    expect(parseRelayUrls('garbage\nws://nope\n')).toEqual([])
  })
})

describe('F3 TURN server validation', () => {
  test('isValidTurnUrl accepts turn: and turns: only', () => {
    expect(isValidTurnUrl('turn:turn.example:3478')).toBe(true)
    expect(isValidTurnUrl('turns:turn.example:443')).toBe(true)
    expect(isValidTurnUrl('TURN:turn.example:3478')).toBe(true)
    expect(isValidTurnUrl('stun:stun.example')).toBe(false)
    expect(isValidTurnUrl('wss://turn.example')).toBe(false)
    expect(isValidTurnUrl('')).toBe(false)
  })

  test('normalizeTurnServer requires all three fields + a valid scheme', () => {
    expect(
      normalizeTurnServer({
        url: 'turn:turn.example:3478',
        username: 'u',
        credential: 'c',
      })
    ).toEqual({ url: 'turn:turn.example:3478', username: 'u', credential: 'c' })
  })

  test('normalizeTurnServer rejects a missing credential', () => {
    expect(
      normalizeTurnServer({ url: 'turn:turn.example:3478', username: 'u' })
    ).toBeNull()
  })

  test('normalizeTurnServer rejects an invalid scheme', () => {
    expect(
      normalizeTurnServer({
        url: 'stun:turn.example',
        username: 'u',
        credential: 'c',
      })
    ).toBeNull()
  })

  test('normalizeTurnServer trims surrounding whitespace', () => {
    expect(
      normalizeTurnServer({
        url: '  turn:turn.example:3478 ',
        username: ' u ',
        credential: ' c ',
      })
    ).toEqual({ url: 'turn:turn.example:3478', username: 'u', credential: 'c' })
  })
})
