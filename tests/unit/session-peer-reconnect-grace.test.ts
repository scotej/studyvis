// #264 — a peer whose transport dropped without leaving keeps its place in the
// grid for a bounded grace window, while a peer who actually left disappears
// at once. Presence accounting closes at the drop in BOTH cases, so a session
// ended mid-grace can never over-count overlap.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import {
  PEER_RECONNECT_GRACE_MS,
  wireSessionRoom,
} from '@/features/session/lifecycle'
import type { TopicRoom } from '@/lib/trystero'
import { installTransientDisconnectHold } from '@/lib/webrtc/resilientPeerConnection'
import { useSessionStore } from '@/stores/sessionStore'

const PEER_ED_PUBKEY = 'a'.repeat(64)

class FakeConnection extends EventTarget {
  connection: RTCPeerConnectionState = 'new'
  ice: RTCIceConnectionState = 'new'

  get connectionState(): RTCPeerConnectionState {
    return this.connection
  }

  get iceConnectionState(): RTCIceConnectionState {
    return this.ice
  }

  transition(
    connection: RTCPeerConnectionState,
    ice: RTCIceConnectionState
  ): void {
    this.connection = connection
    this.ice = ice
    this.dispatchEvent(new Event('connectionstatechange'))
    this.dispatchEvent(new Event('iceconnectionstatechange'))
  }

  close(): void {
    this.connection = 'closed'
    this.ice = 'closed'
  }
}

// `wrapped: false` models the in-process room mocks (and any engine the hold
// could not be installed over): no transport health, so the departure path
// must keep its pre-#264 behavior.
function fakeRoom(options: { wrapped?: boolean } = {}) {
  const wrapped = options.wrapped ?? true
  const joinSubs = new Set<(peerId: string) => void>()
  const leaveSubs = new Set<(peerId: string) => void>()
  const connections = new Map<string, FakeConnection>()
  const room = {
    selfId: 'self',
    makeAction: () => ({
      send: vi.fn(async () => []),
      receive: () => {},
    }),
    onPeerJoin: (fn: (peerId: string) => void) => {
      joinSubs.add(fn)
      return () => joinSubs.delete(fn)
    },
    onPeerLeave: (fn: (peerId: string) => void) => {
      leaveSubs.add(fn)
      return () => leaveSubs.delete(fn)
    },
    onPeerStream: () => () => {},
    addStream: () => {},
    removeStream: () => {},
    getPeers: () => Object.fromEntries(connections),
    leave: async () => {},
  } as unknown as TopicRoom

  return {
    room,
    connection(peerId: string): FakeConnection {
      const connection = connections.get(peerId)
      if (!connection) throw new Error(`no connection for ${peerId}`)
      return connection
    },
    join(peerId: string) {
      if (!connections.has(peerId)) {
        const connection = new FakeConnection()
        if (wrapped) {
          installTransientDisconnectHold(
            connection as unknown as RTCPeerConnection
          )
        }
        connections.set(peerId, connection)
      }
      for (const fn of joinSubs) fn(peerId)
      connections.get(peerId)?.transition('connected', 'connected')
    },
    // trystero destroys the connection before it calls back, so the close
    // always precedes the leave notification.
    leave(peerId: string) {
      connections.get(peerId)?.close()
      connections.delete(peerId)
      for (const fn of leaveSubs) fn(peerId)
    },
  }
}

function beginActive(room: TopicRoom): void {
  useSessionStore.getState().begin({
    sessionTopic: 'topic',
    sessionPassword: 'password',
    isHost: true,
    startedAt: 1_700_000_000_000,
    startedAtMono: 10,
    room,
    leave: async () => {},
  })
}

function helloFrom(peerId: string): void {
  useSessionStore.getState().setPeerHello(peerId, {
    ed_pubkey_hex: PEER_ED_PUBKEY,
    display_name: 'Robin',
    joined_at: 1_700_000_000_000,
  })
}

describe('#264 peer reconnect grace', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    useSessionStore.getState().reset()
  })

  afterEach(() => {
    useSessionStore.getState().reset()
    vi.useRealTimers()
  })

  test('a lost transport keeps the tile and closes presence at the drop', () => {
    const harness = fakeRoom()
    beginActive(harness.room)
    const lifecycle = wireSessionRoom(harness.room, {
      isHost: true,
      leave: async () => {},
    })

    harness.join('peer-a')
    helloFrom('peer-a')
    harness.connection('peer-a').transition('disconnected', 'disconnected')
    harness.leave('peer-a')

    const state = useSessionStore.getState()
    // The room membership is gone; only the grid placeholder survives.
    expect(lifecycle.peers()).toEqual([])
    expect(state.peers['peer-a']?.reconnecting).toBe(true)
    expect(state.peers['peer-a']?.displayName).toBe('Robin')
    // Identity unbound and the overlap interval closed, exactly as a plain
    // departure would leave them.
    expect(state.peers['peer-a']?.edPubkeyHex).toBeNull()
    expect(state.peerPresence[PEER_ED_PUBKEY]?.activeSinceWall).toBeNull()

    lifecycle.dispose()
  })

  test('a rejoin inside the grace resumes the tile and reopens overlap', () => {
    const harness = fakeRoom()
    beginActive(harness.room)
    const lifecycle = wireSessionRoom(harness.room, {
      isHost: true,
      leave: async () => {},
    })

    harness.join('peer-a')
    helloFrom('peer-a')
    harness.connection('peer-a').transition('disconnected', 'disconnected')
    harness.leave('peer-a')

    vi.advanceTimersByTime(PEER_RECONNECT_GRACE_MS - 1)
    harness.join('peer-a')
    helloFrom('peer-a')

    const state = useSessionStore.getState()
    expect(lifecycle.peers()).toEqual(['peer-a'])
    expect(state.peers['peer-a']?.reconnecting).toBe(false)
    expect(state.peers['peer-a']?.edPubkeyHex).toBe(PEER_ED_PUBKEY)
    expect(state.peerPresence[PEER_ED_PUBKEY]?.activeSinceWall).not.toBeNull()

    // The expiry that was pending for this peer must not fire behind it.
    vi.advanceTimersByTime(PEER_RECONNECT_GRACE_MS)
    expect(useSessionStore.getState().peers['peer-a']).toBeDefined()

    lifecycle.dispose()
  })

  test('the tile is dropped when the grace expires', () => {
    const harness = fakeRoom()
    beginActive(harness.room)
    const lifecycle = wireSessionRoom(harness.room, {
      isHost: true,
      leave: async () => {},
    })

    harness.join('peer-a')
    helloFrom('peer-a')
    harness.connection('peer-a').transition('disconnected', 'disconnected')
    harness.leave('peer-a')

    vi.advanceTimersByTime(PEER_RECONNECT_GRACE_MS)

    expect(useSessionStore.getState().peers['peer-a']).toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)

    lifecycle.dispose()
  })

  test('a clean departure removes the peer immediately', () => {
    const harness = fakeRoom()
    beginActive(harness.room)
    const lifecycle = wireSessionRoom(harness.room, {
      isHost: true,
      leave: async () => {},
    })

    harness.join('peer-a')
    helloFrom('peer-a')
    // No degraded transition: the connection was healthy right up to the
    // remote Leave, which is what a deliberate departure looks like.
    harness.leave('peer-a')

    expect(useSessionStore.getState().peers['peer-a']).toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)

    lifecycle.dispose()
  })

  test('a transport with no health reading keeps the pre-#264 behavior', () => {
    const harness = fakeRoom({ wrapped: false })
    beginActive(harness.room)
    const lifecycle = wireSessionRoom(harness.room, {
      isHost: true,
      leave: async () => {},
    })

    harness.join('peer-a')
    helloFrom('peer-a')
    harness.connection('peer-a').transition('disconnected', 'disconnected')
    harness.leave('peer-a')

    expect(useSessionStore.getState().peers['peer-a']).toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)

    lifecycle.dispose()
  })

  test('dispose drops a held tile and leaves no timer behind', () => {
    const harness = fakeRoom()
    beginActive(harness.room)
    const lifecycle = wireSessionRoom(harness.room, {
      isHost: true,
      leave: async () => {},
    })

    harness.join('peer-a')
    helloFrom('peer-a')
    harness.connection('peer-a').transition('disconnected', 'disconnected')
    harness.leave('peer-a')
    lifecycle.dispose()

    expect(useSessionStore.getState().peers['peer-a']).toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
  })
})
