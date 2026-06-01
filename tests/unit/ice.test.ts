import { describe, expect, test } from 'vitest'
import type { TurnServerConfig } from 'trystero'

import {
  buildIceOptions,
  iceOptionsFor,
  PUBLIC_TURN_SERVERS,
} from '@/lib/trystero/ice'

const FIXTURE: TurnServerConfig[] = [
  { urls: 'turn:turn.example.test:3478', username: 'u', credential: 'c' },
]

describe('iceOptionsFor (with TURN servers configured)', () => {
  test("'never' yields STUN-only — no TURN, no relay policy", () => {
    expect(iceOptionsFor('never', FIXTURE)).toEqual({})
  })

  test("'auto' adds TURN as a fallback, default transport policy", () => {
    const opts = iceOptionsFor('auto', FIXTURE)
    expect(opts.turnConfig).toBe(FIXTURE)
    expect(opts.rtcConfig).toBeUndefined()
  })

  test("'always' forces relay-only through TURN", () => {
    const opts = iceOptionsFor('always', FIXTURE)
    expect(opts.turnConfig).toBe(FIXTURE)
    expect(opts.rtcConfig).toEqual({ iceTransportPolicy: 'relay' })
  })
})

describe('iceOptionsFor (no TURN servers)', () => {
  test('every preference degrades to STUN-only — even "always"', () => {
    // Forcing relay-only with zero relays would guarantee a failed connection,
    // so it must NOT be honored when the server list is empty.
    expect(iceOptionsFor('auto', [])).toEqual({})
    expect(iceOptionsFor('always', [])).toEqual({})
    expect(iceOptionsFor('never', [])).toEqual({})
  })
})

describe('buildIceOptions (shipped server list)', () => {
  test('delegates to iceOptionsFor against PUBLIC_TURN_SERVERS', () => {
    expect(buildIceOptions('auto')).toEqual(
      iceOptionsFor('auto', PUBLIC_TURN_SERVERS)
    )
  })
})

describe('PUBLIC_TURN_SERVERS', () => {
  test('any configured entry carries credentials and only turn(s): urls', () => {
    // Empty by default (no reliable public TURN); this guards future additions.
    for (const server of PUBLIC_TURN_SERVERS) {
      const urls = Array.isArray(server.urls) ? server.urls : [server.urls]
      expect(urls.length).toBeGreaterThan(0)
      expect(
        urls.every((u) => u.startsWith('turn:') || u.startsWith('turns:'))
      ).toBe(true)
      expect(typeof server.username).toBe('string')
      expect(typeof server.credential).toBe('string')
    }
  })
})
