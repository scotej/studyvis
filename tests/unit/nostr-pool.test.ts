// I74 — the owned relay WebSocket pool: subscription management, event
// routing/dedupe, reconnect-with-resubscribe. All sockets are fakes; no
// network.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import {
  createRelayPool,
  type PoolSocket,
  type RelayPool,
} from '@/lib/nostr/pool'
import {
  buildPresenceEvent,
  createThrowawaySigner,
  PRESENCE_EVENT_KIND,
  type NostrEvent,
} from '@/lib/nostr/events'

type Listener = (evt: { data?: unknown }) => void

class FakeSocket implements PoolSocket {
  readyState = 0
  sent: string[] = []
  closed = false
  listeners = new Map<string, Listener[]>()

  addEventListener(type: string, fn: Listener): void {
    const list = this.listeners.get(type) ?? []
    list.push(fn)
    this.listeners.set(type, list)
  }

  emit(type: string, evt: { data?: unknown } = {}): void {
    for (const fn of this.listeners.get(type) ?? []) fn(evt)
  }

  open(): void {
    this.readyState = 1
    this.emit('open')
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    this.closed = true
    this.readyState = 3
  }

  frames(): unknown[][] {
    return this.sent.map((s) => JSON.parse(s) as unknown[])
  }
}

function makeHarness(urls: string[]) {
  const sockets = new Map<string, FakeSocket[]>()
  const events: Array<[string, string]> = []
  const opens: number[] = []
  const pool: RelayPool = createRelayPool({
    urls,
    onEvent: (tag, content) => events.push([tag, content]),
    onSocketOpen: () => opens.push(1),
    makeSocket: (url) => {
      const socket = new FakeSocket()
      const list = sockets.get(url) ?? []
      list.push(socket)
      sockets.set(url, list)
      return socket
    },
    reconnectBaseMs: 1_000,
    reconnectMaxMs: 8_000,
  })
  const latest = (url: string): FakeSocket => {
    const list = sockets.get(url)
    if (!list || list.length === 0) throw new Error(`no socket for ${url}`)
    return list[list.length - 1]
  }
  return { pool, sockets, events, opens, latest }
}

function presenceEvent(tag: string, content = 'sealed'): NostrEvent {
  return buildPresenceEvent(createThrowawaySigner(), tag, content, 1_700_000)
}

function eventFrame(subId: string, event: NostrEvent): { data: string } {
  return { data: JSON.stringify(['EVENT', subId, event]) }
}

// The pool mints a random subId; recover it from the REQ it sent.
function sentSubId(socket: FakeSocket): string {
  const req = socket.frames().find((f) => f[0] === 'REQ')
  if (!req) throw new Error('no REQ sent')
  return req[1] as string
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('subscription management', () => {
  test('REQ goes out on open with the tag set, ephemeral kind, and limit 0', () => {
    const h = makeHarness(['wss://a'])
    h.pool.setSubscription(['tag-1', 'tag-2'])
    const socket = h.latest('wss://a')
    socket.open()
    const req = socket.frames().find((f) => f[0] === 'REQ')
    expect(req?.[2]).toEqual({
      kinds: [PRESENCE_EVENT_KIND],
      '#x': ['tag-1', 'tag-2'],
      limit: 0,
    })
    expect(h.opens.length).toBe(1)
    h.pool.close()
  })

  test('a tag-set change re-issues the same subId; empty set sends CLOSE', () => {
    const h = makeHarness(['wss://a'])
    h.pool.setSubscription(['tag-1'])
    const socket = h.latest('wss://a')
    socket.open()
    const subId = sentSubId(socket)

    h.pool.setSubscription(['tag-1', 'tag-2'])
    const reqs = socket.frames().filter((f) => f[0] === 'REQ')
    expect(reqs.length).toBe(2)
    expect(reqs[1][1]).toBe(subId)

    h.pool.setSubscription([])
    expect(socket.frames().at(-1)).toEqual(['CLOSE', subId])
    h.pool.close()
  })

  test('a subscription set before any socket opens is sent once sockets open', () => {
    const h = makeHarness(['wss://a'])
    h.pool.setSubscription(['tag-1'])
    const socket = h.latest('wss://a')
    expect(socket.sent.length).toBe(0)
    socket.open()
    expect(socket.frames().some((f) => f[0] === 'REQ')).toBe(true)
    h.pool.close()
  })
})

describe('publish', () => {
  test('publishes to open sockets only', () => {
    const h = makeHarness(['wss://a', 'wss://b'])
    h.latest('wss://a').open()
    // wss://b never opens.
    h.pool.publish(presenceEvent('tag-1'))
    expect(
      h
        .latest('wss://a')
        .frames()
        .filter((f) => f[0] === 'EVENT').length
    ).toBe(1)
    expect(
      h
        .latest('wss://b')
        .frames()
        .filter((f) => f[0] === 'EVENT').length
    ).toBe(0)
    h.pool.close()
  })
})

describe('event routing', () => {
  test('routes a matching event and dedupes the same id across relays', () => {
    const h = makeHarness(['wss://a', 'wss://b'])
    h.pool.setSubscription(['tag-1'])
    const a = h.latest('wss://a')
    const b = h.latest('wss://b')
    a.open()
    b.open()
    const subId = sentSubId(a)
    const event = presenceEvent('tag-1', 'sealed-content')

    a.emit('message', eventFrame(subId, event))
    b.emit('message', eventFrame(subId, event)) // same event via second relay
    expect(h.events).toEqual([['tag-1', 'sealed-content']])
    h.pool.close()
  })

  test('ignores wrong subId, wrong kind, unknown tag, and junk frames', () => {
    const h = makeHarness(['wss://a'])
    h.pool.setSubscription(['tag-1'])
    const socket = h.latest('wss://a')
    socket.open()
    const subId = sentSubId(socket)

    socket.emit('message', { data: 'not json' })
    socket.emit('message', { data: JSON.stringify(['NOTICE', 'hello']) })
    socket.emit('message', eventFrame('other-sub', presenceEvent('tag-1')))
    socket.emit('message', eventFrame(subId, presenceEvent('other-tag')))
    const wrongKind = { ...presenceEvent('tag-1'), kind: 1 }
    socket.emit('message', eventFrame(subId, wrongKind))
    expect(h.events).toEqual([])
    h.pool.close()
  })
})

describe('reconnect', () => {
  test('a closed socket reconnects with backoff, re-subscribes, and re-fires onSocketOpen', async () => {
    const h = makeHarness(['wss://a'])
    h.pool.setSubscription(['tag-1'])
    const first = h.latest('wss://a')
    first.open()
    expect(h.opens.length).toBe(1)

    first.emit('close')
    await vi.advanceTimersByTimeAsync(1_000)
    const second = h.latest('wss://a')
    expect(second).not.toBe(first)
    second.open()
    expect(second.frames().some((f) => f[0] === 'REQ')).toBe(true)
    expect(h.opens.length).toBe(2)
    h.pool.close()
  })

  test('backoff grows per attempt and resets after a successful open', async () => {
    const h = makeHarness(['wss://a'])
    const first = h.latest('wss://a')
    first.emit('close') // never opened → attempt 0 → 1s
    await vi.advanceTimersByTimeAsync(999)
    expect(h.sockets.get('wss://a')?.length).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(h.sockets.get('wss://a')?.length).toBe(2)

    h.latest('wss://a').emit('close') // attempt 1 → 2s
    await vi.advanceTimersByTimeAsync(1_999)
    expect(h.sockets.get('wss://a')?.length).toBe(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(h.sockets.get('wss://a')?.length).toBe(3)

    h.latest('wss://a').open() // success resets the counter
    h.latest('wss://a').emit('close')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(h.sockets.get('wss://a')?.length).toBe(4)
    h.pool.close()
  })

  test('close() stops reconnects and closes live sockets', async () => {
    const h = makeHarness(['wss://a'])
    const first = h.latest('wss://a')
    first.open()
    h.pool.close()
    expect(first.closed).toBe(true)
    first.emit('close')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.sockets.get('wss://a')?.length).toBe(1)
  })

  test('a constructor throw abandons that URL instead of retrying forever', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      let calls = 0
      const pool = createRelayPool({
        urls: ['wss://bad'],
        onEvent: () => {},
        makeSocket: () => {
          calls += 1
          throw new Error('malformed URL')
        },
        reconnectBaseMs: 1_000,
      })
      await vi.advanceTimersByTimeAsync(60_000)
      expect(calls).toBe(1)
      expect(pool.socketStates()).toEqual([])
      pool.close()
    } finally {
      warn.mockRestore()
    }
  })
})
