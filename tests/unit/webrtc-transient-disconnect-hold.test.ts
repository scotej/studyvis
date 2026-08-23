// #264 — trystero declares a peer gone 5 s after its RTCPeerConnection reports
// `disconnected`, which is shorter than the multi-second process stalls a
// machine running the on-device model produces. These cover the hold that
// keeps a recoverable blip invisible while letting every terminal state
// through untouched.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import {
  installTransientDisconnectHold,
  transportHealthOf,
} from '@/lib/webrtc/resilientPeerConnection'

const HOLD_MS = 20_000

class FakeConnection extends EventTarget {
  connection: RTCPeerConnectionState = 'new'
  ice: RTCIceConnectionState = 'new'

  get connectionState(): RTCPeerConnectionState {
    return this.connection
  }

  get iceConnectionState(): RTCIceConnectionState {
    return this.ice
  }

  // Drives both states the way an engine does: mutate, then notify.
  transition(
    connection: RTCPeerConnectionState,
    ice: RTCIceConnectionState
  ): void {
    this.connection = connection
    this.ice = ice
    this.dispatchEvent(new Event('connectionstatechange'))
    this.dispatchEvent(new Event('iceconnectionstatechange'))
  }

  // close() mutates state without dispatching anything, exactly as the real
  // API does.
  close(): void {
    this.connection = 'closed'
    this.ice = 'closed'
  }
}

type Harness = {
  fake: FakeConnection
  connection: RTCPeerConnection
  // What a reader registered after installation (trystero, SessionView) sees.
  observed: () => RTCPeerConnectionState[]
}

function harness(): Harness {
  const fake = new FakeConnection()
  const connection = fake as unknown as RTCPeerConnection
  installTransientDisconnectHold(connection, HOLD_MS)
  const observed: RTCPeerConnectionState[] = []
  connection.addEventListener('connectionstatechange', () => {
    observed.push(connection.connectionState)
  })
  return { fake, connection, observed: () => observed }
}

describe('#264 transient-disconnect hold', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  test('reports a post-connected disconnected as still connected', () => {
    const { fake, connection } = harness()
    fake.transition('connected', 'connected')
    fake.transition('disconnected', 'disconnected')

    expect(connection.connectionState).toBe('connected')
    expect(connection.iceConnectionState).toBe('connected')
    expect(transportHealthOf(connection)?.holding).toBe(true)
  })

  test('a blip that recovers inside the hold is never surfaced at all', () => {
    const { fake, connection, observed } = harness()
    fake.transition('connected', 'connected')
    const beforeBlip = observed().length

    fake.transition('disconnected', 'disconnected')
    vi.advanceTimersByTime(HOLD_MS - 1)
    fake.transition('connected', 'connected')
    vi.advanceTimersByTime(HOLD_MS)

    expect(connection.connectionState).toBe('connected')
    expect(transportHealthOf(connection)?.holding).toBe(false)
    // Nothing a reader saw across the blip ever said 'disconnected', so
    // trystero's close timer was never armed.
    expect(observed().slice(beforeBlip)).not.toContain('disconnected')
    expect(vi.getTimerCount()).toBe(0)
  })

  test('tells the truth when the hold expires, and does not re-arm', () => {
    const { fake, connection, observed } = harness()
    fake.transition('connected', 'connected')
    fake.transition('disconnected', 'disconnected')

    vi.advanceTimersByTime(HOLD_MS)

    expect(connection.connectionState).toBe('disconnected')
    expect(connection.iceConnectionState).toBe('disconnected')
    expect(observed().at(-1)).toBe('disconnected')

    // A further degraded transition must not start a second hold — that would
    // mask the state trystero is now counting down against, forever.
    fake.transition('disconnected', 'disconnected')
    expect(connection.connectionState).toBe('disconnected')
    expect(vi.getTimerCount()).toBe(0)
  })

  test('a recovery after an expired hold re-arms it for the next blip', () => {
    const { fake, connection } = harness()
    fake.transition('connected', 'connected')
    fake.transition('disconnected', 'disconnected')
    vi.advanceTimersByTime(HOLD_MS)
    fake.transition('connected', 'connected')

    fake.transition('disconnected', 'disconnected')
    expect(connection.connectionState).toBe('connected')
  })

  test('failed is terminal and passes through mid-hold', () => {
    const { fake, connection, observed } = harness()
    fake.transition('connected', 'connected')
    fake.transition('disconnected', 'disconnected')
    expect(connection.connectionState).toBe('connected')

    fake.transition('failed', 'failed')

    expect(connection.connectionState).toBe('failed')
    expect(observed().at(-1)).toBe('failed')
    expect(vi.getTimerCount()).toBe(0)
  })

  test('a handshake that never connected fails fast', () => {
    const { fake, connection } = harness()
    fake.transition('connecting', 'checking')
    fake.transition('disconnected', 'disconnected')

    expect(connection.connectionState).toBe('disconnected')
    expect(vi.getTimerCount()).toBe(0)
  })

  test('records the last live state for the departure heuristic', () => {
    const { fake, connection } = harness()
    fake.transition('connected', 'connected')
    fake.transition('disconnected', 'disconnected')
    fake.close()

    expect(connection.connectionState).toBe('closed')
    expect(transportHealthOf(connection)?.lastLiveConnectionState).toBe(
      'disconnected'
    )
  })

  test('the degraded stretch survives close for the departure log', () => {
    const { fake, connection } = harness()
    fake.transition('connected', 'connected')
    fake.transition('disconnected', 'disconnected')
    vi.advanceTimersByTime(4_000)
    connection.close()

    // features/session reads this after trystero has already destroyed the
    // connection, to report how long the link was degraded when it died.
    expect(transportHealthOf(connection)?.degradedSinceMs).not.toBeNull()
    expect(transportHealthOf(connection)?.holding).toBe(false)
  })

  test('a recovery clears the degraded stretch', () => {
    const { fake, connection } = harness()
    fake.transition('connected', 'connected')
    fake.transition('disconnected', 'disconnected')
    fake.transition('connected', 'connected')

    expect(transportHealthOf(connection)?.degradedSinceMs).toBeNull()
  })

  test('a clean departure leaves the last live state connected', () => {
    const { fake, connection } = harness()
    fake.transition('connected', 'connected')
    fake.close()

    expect(transportHealthOf(connection)?.lastLiveConnectionState).toBe(
      'connected'
    )
  })

  test('closing the connection retires the armed hold', () => {
    const { connection, fake, observed } = harness()
    fake.transition('connected', 'connected')
    fake.transition('disconnected', 'disconnected')
    const beforeClose = observed().length
    connection.close()

    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(HOLD_MS)
    expect(observed().length).toBe(beforeClose)
    expect(connection.connectionState).toBe('closed')
  })

  test('an unwrapped connection reports no transport health', () => {
    const bare = new FakeConnection() as unknown as RTCPeerConnection
    expect(transportHealthOf(bare)).toBeNull()
    expect(transportHealthOf(null)).toBeNull()
  })
})
