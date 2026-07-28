import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { TurnServerConfig } from 'trystero'

import { __resetLog, __setLogRecordSink, type LogRecord } from '@/lib/log'
import {
  buildIceOptions,
  iceOptionsFor,
  PUBLIC_TURN_SERVERS,
  userTurnServers,
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
  let records: LogRecord[]

  beforeEach(() => {
    __resetLog()
    records = []
    __setLogRecordSink((record) => records.push(record))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    __resetLog()
  })

  test('every preference degrades to STUN-only — even "always"', () => {
    // Forcing relay-only with zero relays would guarantee a failed connection,
    // so it must NOT be honored when the server list is empty.
    expect(iceOptionsFor('auto', [])).toEqual({})
    expect(iceOptionsFor('always', [])).toEqual({})
    expect(iceOptionsFor('never', [])).toEqual({})
  })

  test("warns when 'always' is dropped for lack of TURN, not for auto/never", () => {
    iceOptionsFor('auto', [])
    iceOptionsFor('never', [])
    expect(records).toHaveLength(0)
    iceOptionsFor('always', [])
    expect(records).toHaveLength(1)
    expect(records[0]?.scope).toBe('webrtc.ice')
    expect(records[0]?.msg).toBe('turn.relay_only_ignored')
    expect(records[0]?.data).toMatchObject({
      turnPreference: 'always',
      configuredServerCount: 0,
      effective: 'stun-only',
    })
  })
})

describe('buildIceOptions (shipped server list)', () => {
  test('delegates to iceOptionsFor against PUBLIC_TURN_SERVERS', () => {
    // With no user TURN server configured (default settings) and an empty
    // shipped list, every preference degrades to STUN-only.
    expect(buildIceOptions('auto')).toEqual(
      iceOptionsFor('auto', PUBLIC_TURN_SERVERS)
    )
  })
})

describe('F3 userTurnServers', () => {
  test('returns [] when no server is configured', () => {
    expect(userTurnServers(null)).toEqual([])
  })

  test('maps a configured server into trystero TurnServerConfig shape', () => {
    expect(
      userTurnServers({
        url: 'turn:turn.example:3478',
        username: 'u',
        credential: 'c',
      })
    ).toEqual([
      { urls: 'turn:turn.example:3478', username: 'u', credential: 'c' },
    ])
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
