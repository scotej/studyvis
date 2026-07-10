import { beforeEach, describe, expect, test, vi } from 'vitest'

const sockets: Record<string, { readyState: number; url: string }> = {}
const mqttSockets: Record<string, { readyState: number; url: string }> = {}

vi.mock('@/lib/trystero', () => ({
  getRelaySocketMap: () => sockets,
  getMqttRelaySocketMap: () => mqttSockets,
}))

const {
  readyStateToStatus,
  snapshotRelayRows,
  snapshotAllRelayRows,
  relaysUnreachable,
} = await import('@/lib/relayDiagnostics')

beforeEach(() => {
  for (const k of Object.keys(sockets)) delete sockets[k]
  for (const k of Object.keys(mqttSockets)) delete mqttSockets[k]
})

describe('F2 readyStateToStatus', () => {
  test('maps WebSocket readyState to a status', () => {
    expect(readyStateToStatus(0)).toBe('connecting')
    expect(readyStateToStatus(1)).toBe('connected')
    expect(readyStateToStatus(2)).toBe('down')
    expect(readyStateToStatus(3)).toBe('down')
  })
})

describe('F2 snapshotRelayRows', () => {
  test('returns a sorted, status-mapped row per relay', () => {
    sockets['wss://b.example'] = { readyState: 0, url: 'wss://b.example' }
    sockets['wss://a.example'] = { readyState: 1, url: 'wss://a.example' }
    expect(snapshotRelayRows()).toEqual([
      { url: 'wss://a.example', status: 'connected', transport: 'nostr' },
      { url: 'wss://b.example', status: 'connecting', transport: 'nostr' },
    ])
  })

  test('returns [] when no relays are connected', () => {
    expect(snapshotRelayRows()).toEqual([])
  })
})

describe('F1/F6 relaysUnreachable', () => {
  test('false when no room has been joined yet (nothing to judge)', () => {
    expect(relaysUnreachable()).toBe(false)
  })

  test('false when at least one relay is OPEN', () => {
    sockets['wss://a.example'] = { readyState: 0, url: 'wss://a.example' }
    sockets['wss://b.example'] = { readyState: 1, url: 'wss://b.example' }
    expect(relaysUnreachable()).toBe(false)
  })

  test('true when relays exist but none is OPEN', () => {
    sockets['wss://a.example'] = { readyState: 0, url: 'wss://a.example' }
    sockets['wss://b.example'] = { readyState: 3, url: 'wss://b.example' }
    expect(relaysUnreachable()).toBe(true)
  })
})

// #47 C3 — the diagnostics panel reads both transports; the invite-path
// signal (relaysUnreachable / snapshotRelayRows) stays Nostr-only.
describe('snapshotAllRelayRows (#47 C3)', () => {
  test('labels rows by transport, nostr first', () => {
    sockets['wss://a.example'] = { readyState: 3, url: 'wss://a.example' }
    mqttSockets['wss://broker.example/mqtt'] = {
      readyState: 1,
      url: 'wss://broker.example/mqtt',
    }
    expect(snapshotAllRelayRows()).toEqual([
      { url: 'wss://a.example', status: 'down', transport: 'nostr' },
      {
        url: 'wss://broker.example/mqtt',
        status: 'connected',
        transport: 'mqtt',
      },
    ])
  })

  test('snapshotRelayRows never includes MQTT sockets', () => {
    mqttSockets['wss://broker.example/mqtt'] = {
      readyState: 1,
      url: 'wss://broker.example/mqtt',
    }
    expect(snapshotRelayRows()).toEqual([])
  })
})
