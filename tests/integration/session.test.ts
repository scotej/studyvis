import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

// Mock the Tauri invoke surface BEFORE importing modules that depend on it,
// so sessions_insert calls land in `invokeMock` instead of trying to reach
// a Tauri runtime that doesn't exist in node.
const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}))

// In-process trystero bus, extended for streams + targeted action sends so the
// session lifecycle (addStream / onPeerStream / makeAction targetPeers /
// getPeers().close()) is exercised end-to-end without WebRTC.
vi.mock('@/lib/trystero', () => {
  type Listener = (peerId: string) => void
  type Receiver = (data: unknown, peerId: string) => void
  type StreamHandler = (stream: unknown, peerId: string) => void

  type BusRoom = {
    peerId: string
    onJoin: Listener[]
    onLeave: Listener[]
    onStream: StreamHandler[]
    receivers: Map<string, Receiver[]>
    streams: unknown[]
    // I77 — trystero's `activePeerMap` for this room: the peers a stream
    // broadcast can actually reach at the moment it is called. A peer lands
    // here only once the (simulated) handshake completes.
    active: Set<string>
    left: boolean
  }
  type Bus = { rooms: Map<string, BusRoom> }

  const buses = new Map<string, Bus>()
  const peerConnections = new Map<string, Map<string, FakePeerConnection>>()
  let nextPeer = 0

  class FakePeerConnection {
    closed = false
    close() {
      this.closed = true
      // Closing the connection on the host side simulates a forced eviction:
      // the remote peer leaves the bus on receipt of 'session-full' anyway,
      // but production also closes the underlying RTCPeerConnection. The bus
      // mock can't propagate close() across peers without ambiguity, so we
      // record the call and let the 'session-full' action drive the leave.
    }
  }

  function getBus(key: string): Bus {
    let bus = buses.get(key)
    if (!bus) {
      bus = { rooms: new Map() }
      buses.set(key, bus)
    }
    return bus
  }

  function joinTopic({ topic, password }: { topic: string; password: string }) {
    const key = `${topic}|${password}`
    const bus = getBus(key)
    const peerId = `peer-${++nextPeer}`
    const room: BusRoom = {
      peerId,
      onJoin: [],
      onLeave: [],
      onStream: [],
      receivers: new Map(),
      streams: [],
      active: new Set(),
      left: false,
    }
    bus.rooms.set(peerId, room)
    if (!peerConnections.has(key)) peerConnections.set(key, new Map())

    queueMicrotask(() => {
      if (room.left) return
      for (const other of bus.rooms.values()) {
        if (other === room || other.left) continue
        // I77 — both sides become active, then both see the join. Streams are
        // deliberately NOT replayed: real trystero never re-sends a stream
        // added before the peer activated (@trystero-p2p/core room.mjs:83,
        // :306-314). Delivery to a late joiner happens only because the app
        // re-adds the stream from its own onPeerJoin handler, which the
        // notifications below are what drive.
        room.active.add(other.peerId)
        other.active.add(room.peerId)
        for (const fn of room.onJoin) fn(other.peerId)
        for (const fn of other.onJoin) fn(room.peerId)
      }
    })

    return {
      selfId: peerId,
      makeAction<T>(namespace: string) {
        const send = async (
          data: T,
          targetPeers?: string | string[] | null
        ): Promise<void> => {
          const allow =
            targetPeers == null
              ? null
              : Array.isArray(targetPeers)
                ? new Set(targetPeers)
                : new Set([targetPeers])
          for (const other of bus.rooms.values()) {
            if (other === room || other.left) continue
            if (allow && !allow.has(other.peerId)) continue
            const handlers = other.receivers.get(namespace) ?? []
            for (const h of handlers) h(data, room.peerId)
          }
        }
        const receive = (cb: (data: T, peerId: string) => void) => {
          const list = room.receivers.get(namespace) ?? []
          list.push(cb as Receiver)
          room.receivers.set(namespace, list)
        }
        return { send, receive }
      },
      onPeerJoin: (fn: Listener) => {
        room.onJoin.push(fn)
        return () => {
          const i = room.onJoin.indexOf(fn)
          if (i >= 0) room.onJoin.splice(i, 1)
        }
      },
      onPeerLeave: (fn: Listener) => {
        room.onLeave.push(fn)
        return () => {
          const i = room.onLeave.indexOf(fn)
          if (i >= 0) room.onLeave.splice(i, 1)
        }
      },
      onPeerStream: (fn: StreamHandler) => {
        // I77 — no replay. Real trystero assigns this listener bare
        // (room.mjs:511); only onPeerJoin sweeps already-active peers.
        room.onStream.push(fn)
        return () => {
          const i = room.onStream.indexOf(fn)
          if (i >= 0) room.onStream.splice(i, 1)
        }
      },
      addStream: (stream: unknown, targetPeers?: string | string[] | null) => {
        room.streams.push(stream)
        // I77 — reaches exactly the peers named, or every peer active AT THIS
        // INSTANT when untargeted. Nothing is queued for a later joiner.
        const targets =
          targetPeers == null
            ? room.active
            : new Set(Array.isArray(targetPeers) ? targetPeers : [targetPeers])
        for (const id of targets) {
          const other = bus.rooms.get(id)
          if (!other || other === room || other.left) continue
          for (const fn of other.onStream) fn(stream, room.peerId)
        }
      },
      removeStream: (stream: unknown) => {
        const idx = room.streams.indexOf(stream)
        if (idx >= 0) room.streams.splice(idx, 1)
      },
      getPeers: () => {
        const conns = peerConnections.get(key)!
        const out: Record<string, FakePeerConnection> = {}
        for (const other of bus.rooms.values()) {
          if (other === room || other.left) continue
          let conn = conns.get(`${peerId}->${other.peerId}`)
          if (!conn) {
            conn = new FakePeerConnection()
            conns.set(`${peerId}->${other.peerId}`, conn)
          }
          out[other.peerId] = conn
        }
        return out as unknown as Record<string, RTCPeerConnection>
      },
      leave: async (): Promise<void> => {
        if (room.left) return
        room.left = true
        bus.rooms.delete(peerId)
        for (const other of bus.rooms.values()) {
          other.active.delete(peerId)
          for (const fn of other.onLeave) fn(peerId)
        }
      },
    }
  }

  return {
    joinTopic,
    APP_ID: 'studyvis',
    __resetBus: () => {
      buses.clear()
      peerConnections.clear()
      nextPeer = 0
    },
  }
})

import { hostSession, joinSession, rejoinSession } from '@/features/session'
import { MAX_REMOTE_PEERS } from '@/features/session/lifecycle'
import { useSessionStore } from '@/stores/sessionStore'

beforeEach(async () => {
  invokeMock.mockReset()
  invokeMock.mockResolvedValue(undefined)
  const mod = (await import('@/lib/trystero')) as unknown as {
    __resetBus: () => void
  }
  mod.__resetBus()
  useSessionStore.setState({
    status: 'idle',
    sessionTopic: null,
    sessionPassword: null,
    isHost: false,
    startedAt: null,
    hadAnyPeer: false,
    peers: {},
    room: null,
    leave: null,
  })
})

afterEach(() => {
  vi.useRealTimers()
})

async function flushMicrotasks(times = 4): Promise<void> {
  for (let i = 0; i < times; i++) {
    await new Promise((r) => setTimeout(r, 0))
  }
}

describe('two in-process apps in the same room observe peer events', () => {
  test('host + guest see each other via onPeerJoin and onPeerLeave', async () => {
    const host = hostSession()
    const guest = joinSession(host.sessionTopic, host.sessionPassword)
    await flushMicrotasks()

    // Each side sees exactly the other peer (mesh of 2). The peer ids are
    // assigned by the bus mock, so just check shape, not values.
    expect(host.peers()).toHaveLength(1)
    expect(guest.peers()).toHaveLength(1)
    expect(host.peers()[0]).not.toBe(guest.peers()[0])

    await guest.leave()
    await flushMicrotasks()

    // S1 — after the guest leaves, the host's set drops to 0 but the auto-end
    // is now debounced by DISCONNECT_GRACE_MS (a WiFi blip shouldn't kill a
    // long session). Within the grace window only the guest's explicit leave
    // has persisted; the host's auto-end is still pending.
    const insertCalls = invokeMock.mock.calls.filter(
      ([cmd]) => cmd === 'sessions_insert'
    )
    expect(insertCalls).toHaveLength(1)
    expect(insertCalls[0]?.[1]).toMatchObject({ id: host.sessionTopic })

    // Cleanup — explicit host leave is idempotent with the (still-pending)
    // grace-armed auto-end, so the host persists exactly once more.
    await host.leave()
  })

  test('guest join observers fire only after a new authenticated peer binding', async () => {
    const host = hostSession()
    const authenticatedPeers: string[] = []
    const guest = joinSession(host.sessionTopic, host.sessionPassword, {
      onPeerAuthenticated: (edPubkeyHex) =>
        authenticatedPeers.push(edPubkeyHex),
    })
    await flushMicrotasks()

    const hostPeerId = guest.peers()[0]
    expect(hostPeerId).toBeDefined()
    // SessionView calls setPeerHello only after validating the hello signature
    // and checking admission; this isolates join.ts's one-shot observation of
    // that authenticated binding.
    useSessionStore.getState().setPeerHello(hostPeerId!, {
      ed_pubkey_hex: 'inviter-key',
      display_name: 'Inviter',
      joined_at: 1,
    })
    useSessionStore.getState().setPeerHello(hostPeerId!, {
      ed_pubkey_hex: 'inviter-key',
      display_name: 'Renamed inviter',
      joined_at: 2,
    })

    expect(authenticatedPeers).toEqual(['inviter-key'])

    await guest.leave()
    useSessionStore.getState().setPeerHello('late-peer', {
      ed_pubkey_hex: 'late-key',
      display_name: 'Late peer',
      joined_at: 3,
    })
    expect(authenticatedPeers).toEqual(['inviter-key'])

    await host.leave()
  })
})

describe('mesh hard-cap', () => {
  test(`host evicts the 4th remote peer (5th total user)`, async () => {
    const host = hostSession()
    const guests = [
      joinSession(host.sessionTopic, host.sessionPassword),
      joinSession(host.sessionTopic, host.sessionPassword),
      joinSession(host.sessionTopic, host.sessionPassword),
      joinSession(host.sessionTopic, host.sessionPassword),
    ]
    // 4 joiners attempt to join; only MAX_REMOTE_PEERS = 3 should stick on
    // the host's side. The 4th joiner receives 'session-full' and tears down.
    await flushMicrotasks(12)

    expect(host.peers()).toHaveLength(MAX_REMOTE_PEERS)

    // Exactly one guest auto-left (received 'session-full', then ran its
    // leave handler which upserts a single sessions row before any
    // explicit cleanup runs). Host + 3 remaining guests are still open.
    const insertCallsBeforeCleanup = invokeMock.mock.calls.filter(
      ([cmd]) => cmd === 'sessions_insert'
    )
    expect(insertCallsBeforeCleanup).toHaveLength(1)

    // Cleanup so rooms don't leak across tests. Each leave is idempotent.
    await host.leave()
    for (const g of guests) await g.leave()
  })

  test('a rejoined host preserves host role and cap enforcement', async () => {
    const topic = 'rejoin-host-topic'
    const password = 'rejoin-host-password'
    const host = rejoinSession(topic, password, true)
    expect(useSessionStore.getState().isHost).toBe(true)

    const guests = [
      joinSession(topic, password),
      joinSession(topic, password),
      joinSession(topic, password),
      joinSession(topic, password),
    ]
    await flushMicrotasks(12)

    expect(host.peers()).toHaveLength(MAX_REMOTE_PEERS)

    await host.leave()
    for (const guest of guests) await guest.leave()
  })

  test('a same-topic invite accepted from the prior report preserves focus continuity', async () => {
    // This is the guest re-invite path, not the Report's explicit rejoin
    // button. The ended store still names the logical session while its report
    // is open, so joinSession must not reset focus for its next stint.
    useSessionStore.setState({
      status: 'ended',
      sessionTopic: 'same-topic-invite',
      sessionPassword: 'old-password',
      isRejoin: false,
    })

    const guest = joinSession('same-topic-invite', 'fresh-invite-password')
    expect(useSessionStore.getState().isRejoin).toBe(true)
    await guest.leave()
  })
})

describe('leave handler tears down the room and persists a sessions row', () => {
  test('explicit host.leave persists with id == session_topic + V2-P8 report fields', async () => {
    const host = hostSession()
    const guest = joinSession(host.sessionTopic, host.sessionPassword)
    await flushMicrotasks()

    invokeMock.mockClear()
    invokeMock.mockResolvedValue(undefined)

    const beforeLeaveAt = Date.now()
    await host.leave()
    const afterLeaveAt = Date.now()

    const insertCall = invokeMock.mock.calls.find(
      ([cmd]) => cmd === 'sessions_insert'
    )
    expect(insertCall).toBeDefined()
    const args = insertCall?.[1] as
      | {
          id: string
          startedAt: number
          endedAt: number
          totalMinutes: number
          declaredTopic: string | null
          score: number | null
          focusedPct: number | null
          generatedAt: number | null
        }
      | undefined
    expect(args?.id).toBe(host.sessionTopic)
    expect(args?.startedAt).toBeLessThanOrEqual(beforeLeaveAt)
    expect(args?.endedAt).toBeGreaterThanOrEqual(beforeLeaveAt)
    expect(args?.endedAt).toBeLessThanOrEqual(afterLeaveAt + 5)
    expect(args?.totalMinutes).toBeGreaterThanOrEqual(0)
    // R1: an AI-off session (the sample loop never ran) persists score=null,
    // not a fabricated 100 — statsData.averageScore skips nulls and the
    // Report renders its no-score state. focused_pct is likewise null. The
    // declaredTopic comes from the V2-P7 session-start default; generated_at
    // == ended_at because the leave handler runs the upsert synchronously.
    expect(args?.declaredTopic).toBe('Studying')
    expect(args?.score).toBeNull()
    expect(args?.focusedPct).toBeNull()
    expect(args?.generatedAt).toBe(args?.endedAt)

    await guest.leave()
  })

  test('leave is idempotent — calling twice persists exactly once', async () => {
    const host = hostSession()
    await flushMicrotasks()

    invokeMock.mockClear()
    invokeMock.mockResolvedValue(undefined)

    await host.leave()
    await host.leave()

    const insertCalls = invokeMock.mock.calls.filter(
      ([cmd]) => cmd === 'sessions_insert'
    )
    expect(insertCalls).toHaveLength(1)
  })
})
