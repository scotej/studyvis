// I225 — the patched @trystero-p2p/nostr relay batcher. Rejoining the same
// session reuses the root and self topics byte-identically (trystero's selfId
// is a per-process constant), so a leaving room's relay unsubscribe must only
// retract the handler it registered itself. The installed artifact is imported
// directly: this asserts the shipped patch, not a re-implementation of it.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const { joinRoom } = (await import(
  new URL(
    '../../node_modules/@trystero-p2p/nostr/dist/index.mjs',
    import.meta.url
  ).href
)) as {
  joinRoom: (
    config: Record<string, unknown>,
    roomId: string
  ) => { leave: () => Promise<void> }
}

type Frame = [string, ...unknown[]]

// Sockets do not open on construction: the test decides when `client.ready`
// resolves, which is what holds a leaving room's subscription pending.
class FakeSocket {
  static live: FakeSocket[] = []

  readyState = 0
  url: string
  sent: string[] = []
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null

  constructor(url: string) {
    this.url = url
    FakeSocket.live.push(this)
  }

  open(): void {
    this.readyState = 1
    this.onopen?.()
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    this.readyState = 3
    this.onclose?.()
  }

  frames(): Frame[] {
    return this.sent.map((raw) => JSON.parse(raw) as Frame)
  }

  framesOfType(type: string): Frame[] {
    return this.frames().filter((frame) => frame[0] === type)
  }
}

// A REQ carries `{kinds, since, '#x': [...topics]}`; the topic list is the
// batcher's live key set, so it is the observable for "who is still subscribed".
function subscribedTopics(socket: FakeSocket): string[] {
  const req = socket.framesOfType('REQ').at(-1)
  if (!req) return []
  const filter = req[2] as { ['#x']?: string[] } | undefined
  return [...(filter?.['#x'] ?? [])].sort()
}

// Trystero warms a pool of 20 offer peers per room. None of them is exercised
// here, so the polyfill only has to survive construction: a non-stable
// signalling state keeps peer.mjs from kicking off negotiation.
class FakePeerConnection {
  signalingState = 'have-local-offer'
  connectionState = 'new'
  iceConnectionState = 'new'
  iceGatheringState = 'new'
  localDescription: { type: string; sdp: string } | null = null
  onnegotiationneeded: unknown = null
  onicecandidate: unknown = null
  onconnectionstatechange: unknown = null
  ontrack: unknown = null
  onremovestream: unknown = null
  ondatachannel: unknown = null

  createDataChannel(): Record<string, unknown> {
    return {
      binaryType: '',
      bufferedAmountLowThreshold: 0,
      readyState: 'connecting',
      onmessage: null,
      onopen: null,
      onclose: null,
      onerror: null,
      close: () => {},
      send: () => {},
    }
  }

  addEventListener(): void {}
  removeEventListener(): void {}
  getSenders(): unknown[] {
    return []
  }
  close(): void {
    this.connectionState = 'closed'
    this.signalingState = 'closed'
  }
}

let originalWebSocket: unknown
let roomCounter = 0

// Every test gets its own relay URL, appId and roomId: the nostr module keeps
// `batchers` and the relay registry in module scope for the whole process.
function scope(): { url: string; appId: string; roomId: string } {
  roomCounter += 1
  return {
    url: `wss://relay-${roomCounter}.invalid`,
    appId: `studyvis-test-${roomCounter}`,
    roomId: `room-${roomCounter}`,
  }
}

function configFor(url: string, appId: string): Record<string, unknown> {
  return {
    appId,
    password: 'test-password',
    rtcPolyfill: FakePeerConnection,
    relayConfig: { urls: [url], redundancy: 1, warnOnRelayFailure: false },
  }
}

function socketFor(url: string): FakeSocket {
  const socket = FakeSocket.live.filter((s) => s.url === url).at(-1)
  if (!socket) throw new Error(`no socket opened for ${url}`)
  return socket
}

// Topic hashing and event signing go through WebCrypto, which settles off the
// timer queue, so alternate real event-loop turns with the faked ones until the
// subscribe / detached-unsubscribe chains and the batcher's flush have all run.
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await new Promise((resolve) => setImmediate(resolve))
    await vi.advanceTimersByTimeAsync(1)
  }
}

// `leave()` waits out a bounded leave-signal race and a 99 ms peer-teardown
// delay, both on the faked clock.
async function leaveRoom(room: { leave: () => Promise<void> }): Promise<void> {
  const left = room.leave()
  await vi.advanceTimersByTimeAsync(2_000)
  await left
  await settle()
}

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
  })
  FakeSocket.live = []
  originalWebSocket = (globalThis as { WebSocket?: unknown }).WebSocket
  ;(globalThis as { WebSocket?: unknown }).WebSocket = FakeSocket
})

afterEach(() => {
  vi.useRealTimers()
  ;(globalThis as { WebSocket?: unknown }).WebSocket = originalWebSocket
})

describe('patched Trystero nostr subscription ownership', () => {
  test('a pending leave does not unsubscribe the replacement room', async () => {
    const { url, appId, roomId } = scope()
    const config = configFor(url, appId)

    // The relay is still connecting, so the leaving room's subscribe — and
    // therefore its unsubscribe — cannot resolve yet.
    const leaving = joinRoom(config, roomId)
    await settle()
    await leaveRoom(leaving)

    const replacement = joinRoom(config, roomId)
    await settle()

    // Both rooms now resolve against the same relay: the old room subscribes,
    // the replacement overwrites the topic handlers, then the old room's
    // detached cleanup runs.
    const socket = socketFor(url)
    socket.open()
    await settle()

    const topics = subscribedTopics(socket)
    expect(topics).toHaveLength(2)
    expect(socket.framesOfType('CLOSE')).toHaveLength(0)

    // The batcher entry itself must survive, or the relay is silent forever:
    // resubscribeOnReconnect early-returns when `batchers[url]` is gone.
    socket.close()
    await vi.advanceTimersByTimeAsync(10_000)
    const reconnected = socketFor(url)
    expect(reconnected).not.toBe(socket)
    reconnected.open()
    await settle()
    expect(subscribedTopics(reconnected)).toEqual(topics)

    await leaveRoom(replacement)
  })

  test('the replacement room keeps receiving after a repeated leave/rejoin', async () => {
    const { url, appId, roomId } = scope()
    const config = configFor(url, appId)

    let current = joinRoom(config, roomId)
    await settle()
    for (let i = 0; i < 3; i += 1) {
      await leaveRoom(current)
      current = joinRoom(config, roomId)
      await settle()
    }

    const socket = socketFor(url)
    socket.open()
    await settle()

    expect(subscribedTopics(socket)).toHaveLength(2)
    expect(socket.framesOfType('CLOSE')).toHaveLength(0)

    await leaveRoom(current)
  })

  test('an ordinary leave still retracts its own subscriptions', async () => {
    const { url, appId, roomId } = scope()
    const config = configFor(url, appId)

    const room = joinRoom(config, roomId)
    await settle()
    const socket = socketFor(url)
    socket.open()
    await settle()

    expect(subscribedTopics(socket)).toHaveLength(2)

    await leaveRoom(room)

    // Last subscriber gone: the batcher closes every subscription it opened.
    expect(socket.framesOfType('CLOSE').length).toBeGreaterThan(0)
  })
})
