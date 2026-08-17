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
import {
  ADMISSION_AUTHENTICATION_TIMEOUT_MS,
  MAX_REMOTE_PEERS,
  REJOIN_WINDOW_MS,
} from '@/features/session/lifecycle'
import { createSessionStore, useSessionStore } from '@/stores/sessionStore'

beforeEach(async () => {
  invokeMock.mockReset()
  invokeMock.mockResolvedValue(undefined)
  const mod = (await import('@/lib/trystero')) as unknown as {
    __resetBus: () => void
  }
  mod.__resetBus()
  useSessionStore.getState().reset()
})

afterEach(() => {
  vi.useRealTimers()
})

async function flushMicrotasks(times = 4): Promise<void> {
  for (let i = 0; i < times; i++) {
    await new Promise((r) => setTimeout(r, 0))
  }
}

// Each handle below has its own Zustand store, mirroring separate desktop
// webviews while the in-process Trystero bus supplies their shared room.
describe('two room handles on the in-process bus observe peer events', () => {
  test('a guest Leave leaves the host live, able to accept another peer, until its own Leave', async () => {
    const hostStore = createSessionStore()
    const guestStore = createSessionStore()
    const replacementStore = createSessionStore()
    const host = hostSession({ store: hostStore })
    const guest = joinSession(host.sessionTopic, host.sessionPassword, {
      store: guestStore,
    })
    await flushMicrotasks()

    // Each side sees exactly the other peer (mesh of 2). The peer ids are
    // assigned by the bus mock, so just check shape, not values.
    expect(host.peers()).toHaveLength(1)
    expect(guest.peers()).toHaveLength(1)
    expect(host.peers()[0]).not.toBe(guest.peers()[0])
    const hostRoom = hostStore.getState().room
    const hostLeave = hostStore.getState().leave
    expect(hostStore.getState().status).toBe('active')
    expect(hostRoom).toBe(host.room)
    expect(hostLeave).toBe(host.leave)
    expect(hostLeave).toEqual(expect.any(Function))

    // Install the fake clock before departure so this test would capture any
    // regression that schedules a survivor-side timeout from the leave event.
    vi.useFakeTimers()
    await guest.leave()

    // #210 — remote departure changes membership only. The guest persisted
    // its own report; the host remains in the same live room.
    let insertCalls = invokeMock.mock.calls.filter(
      ([cmd]) => cmd === 'sessions_insert'
    )
    expect(insertCalls).toHaveLength(1)
    expect(insertCalls[0]?.[1]).toMatchObject({ id: host.sessionTopic })
    expect(host.peers()).toEqual([])
    expect(guestStore.getState().status).toBe('ended')
    expect(hostStore.getState()).toMatchObject({
      status: 'active',
      room: hostRoom,
      leave: hostLeave,
      rejoinDeadline: null,
    })

    // Advancing past the old survivor-side grace deadline cannot persist or
    // end the host — there is no empty-room timer left to fire.
    await vi.advanceTimersByTimeAsync(REJOIN_WINDOW_MS + 1)
    vi.useRealTimers()
    insertCalls = invokeMock.mock.calls.filter(
      ([cmd]) => cmd === 'sessions_insert'
    )
    expect(insertCalls).toHaveLength(1)
    expect(hostStore.getState()).toMatchObject({
      status: 'active',
      room: hostRoom,
      leave: hostLeave,
      rejoinDeadline: null,
    })

    const nextGuest = joinSession(host.sessionTopic, host.sessionPassword, {
      store: replacementStore,
    })
    await flushMicrotasks()
    expect(host.peers()).toEqual([nextGuest.room.selfId])
    expect(nextGuest.peers()).toEqual([host.room.selfId])
    expect(hostStore.getState().status).toBe('active')
    expect(replacementStore.getState().status).toBe('active')

    // Only the host's explicit local Leave ends its store and persists the
    // second row; the replacement remains active in its own app instance.
    await host.leave()
    insertCalls = invokeMock.mock.calls.filter(
      ([cmd]) => cmd === 'sessions_insert'
    )
    expect(insertCalls).toHaveLength(2)
    expect(insertCalls[1]?.[1]).toMatchObject({
      id: host.sessionTopic,
      peerPresenceMs: '{}',
    })
    expect(hostStore.getState().status).toBe('ended')
    expect(guestStore.getState().status).toBe('ended')
    expect(replacementStore.getState().status).toBe('active')
    await nextGuest.room.leave()
  })

  test('a departed guest rejoins the same live room on a fresh invite', async () => {
    const hostStore = createSessionStore()
    const guestStore = createSessionStore()
    const host = hostSession({ store: hostStore })
    let guest = joinSession(host.sessionTopic, host.sessionPassword, {
      store: guestStore,
    })
    await flushMicrotasks()
    expect(host.peers()).toHaveLength(1)

    // #225 — the reported reproduction, from the departing app instance's own
    // side: leave, then accept another invite carrying the same credentials.
    // Repeated, because the transport defect behind it only surfaced once a
    // replacement room had been built on top of a still-unwinding one.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await guest.leave()
      await flushMicrotasks()
      expect(guestStore.getState().status).toBe('ended')
      expect(hostStore.getState().status).toBe('active')
      expect(host.peers()).toEqual([])

      guest = joinSession(host.sessionTopic, host.sessionPassword, {
        store: guestStore,
      })
      await flushMicrotasks()

      // Not an empty room on either side.
      expect(host.peers()).toEqual([guest.room.selfId])
      expect(guest.peers()).toEqual([host.room.selfId])
      expect(guestStore.getState()).toMatchObject({
        status: 'active',
        sessionTopic: host.sessionTopic,
        // Re-entering the room we just left continues the same logical
        // session, so the stint merges rather than starting a second row.
        isRejoin: true,
        peers: { [host.room.selfId]: expect.anything() },
      })
      // The survivor never rebuilt its room; it is the same one throughout.
      expect(hostStore.getState().room).toBe(host.room)
    }

    await guest.leave()
    await host.leave()

    // Every stint merges into the one topic-keyed row.
    const insertedIds = invokeMock.mock.calls
      .filter(([cmd]) => cmd === 'sessions_insert')
      .map(([, args]) => (args as { id: string }).id)
    expect(insertedIds).toHaveLength(5)
    expect(new Set(insertedIds)).toEqual(new Set([host.sessionTopic]))
  })

  // #225 — what a launch-time recovery rejoin actually walks into. A restarted
  // app instance gets a fresh Trystero peer id, which the bus mock reproduces
  // by handing the replacement store the next `peer-N`.
  test('a restarted guest is readmitted by the host that stayed', async () => {
    const hostStore = createSessionStore()
    const guestStore = createSessionStore()
    const restartedStore = createSessionStore()
    const host = hostSession({ store: hostStore })
    const guest = joinSession(host.sessionTopic, host.sessionPassword, {
      store: guestStore,
    })
    await flushMicrotasks()
    expect(host.peers()).toHaveLength(1)

    // The guest quits StudyVis: the leave handler still runs, and the host
    // keeps the room.
    await guest.leave()
    await flushMicrotasks()
    expect(hostStore.getState().status).toBe('active')

    // Relaunch: a brand-new store and peer id, re-entering with the stored
    // credentials and role exactly as the recovery prompt does.
    const restarted = rejoinSession(
      host.sessionTopic,
      host.sessionPassword,
      false,
      { store: restartedStore }
    )
    await flushMicrotasks(12)

    expect(host.peers()).toEqual([restarted.room.selfId])
    expect(restarted.peers()).toEqual([host.room.selfId])
    expect(restartedStore.getState().status).toBe('active')

    await restarted.leave()
    await host.leave()
  })

  // The mirror case, and the one that decides whether the recovery prompt may
  // offer a host-role rejoin at all.
  test('a restarted host is not readmitted by the guest that stayed', async () => {
    const hostStore = createSessionStore()
    const survivorStore = createSessionStore()
    const restartedStore = createSessionStore()
    const host = hostSession({ store: hostStore })
    const survivor = joinSession(host.sessionTopic, host.sessionPassword, {
      store: survivorStore,
    })
    await flushMicrotasks()
    expect(survivor.peers()).toHaveLength(1)

    await host.leave()
    await flushMicrotasks()
    // #219 — the survivor keeps studying solo, with admissions frozen to the
    // roster it last authenticated.
    expect(survivorStore.getState().status).toBe('active')
    expect(survivor.peers()).toEqual([])

    const restarted = rejoinSession(
      host.sessionTopic,
      host.sessionPassword,
      true,
      { store: restartedStore }
    )
    await flushMicrotasks(16)
    vi.useFakeTimers()
    await vi.advanceTimersByTimeAsync(ADMISSION_AUTHENTICATION_TIMEOUT_MS)
    vi.useRealTimers()

    // #219 froze the survivor's admissions to the departed host's TRANSPORT
    // id, and a restarted process presents a new one. So the survivor never
    // readmits it, and the returning host is talking to nobody — the returning
    // side's own peer list is not evidence to the contrary, because the bus
    // mock cannot propagate the survivor's transport close back across it.
    // This is why the launch-time recovery prompt covers guest records only;
    // reopening it for hosts means identity-based authority rebinding, which
    // is a wire-contract change, not a UI one.
    expect(survivor.peers()).toEqual([])
    expect(survivorStore.getState().status).toBe('active')

    await restarted.leave()
    await survivor.leave()
  })

  test('an unexplained transport loss also leaves the survivor active', async () => {
    const hostStore = createSessionStore()
    const guestStore = createSessionStore()
    const replacementStore = createSessionStore()
    const host = hostSession({ store: hostStore })
    const guest = joinSession(host.sessionTopic, host.sessionPassword, {
      store: guestStore,
    })
    await flushMicrotasks()
    const hostRoom = hostStore.getState().room
    const hostLeave = hostStore.getState().leave

    invokeMock.mockClear()
    // Bypass the guest's local teardown/signed-left path: this is a process or
    // network disappearance as observed solely through Trystero membership.
    // Capture any timer scheduled by the raw membership-loss callback.
    vi.useFakeTimers()
    await guest.room.leave()

    expect(host.peers()).toEqual([])
    expect(hostStore.getState()).toMatchObject({
      status: 'active',
      room: hostRoom,
      leave: hostLeave,
      rejoinDeadline: null,
    })
    expect(
      invokeMock.mock.calls.filter(([cmd]) => cmd === 'sessions_insert')
    ).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(REJOIN_WINDOW_MS + 1)
    vi.useRealTimers()
    expect(
      invokeMock.mock.calls.filter(([cmd]) => cmd === 'sessions_insert')
    ).toHaveLength(0)
    expect(hostStore.getState()).toMatchObject({
      status: 'active',
      room: hostRoom,
      leave: hostLeave,
      rejoinDeadline: null,
    })

    const replacement = joinSession(host.sessionTopic, host.sessionPassword, {
      store: replacementStore,
    })
    await flushMicrotasks()
    expect(host.peers()).toEqual([replacement.room.selfId])
    expect(replacementStore.getState().status).toBe('active')

    await host.leave()
    expect(
      invokeMock.mock.calls.filter(([cmd]) => cmd === 'sessions_insert')
    ).toHaveLength(1)
    expect(hostStore.getState().status).toBe('ended')
    expect(replacementStore.getState().status).toBe('active')
    await replacement.room.leave()
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
      ed_pubkey_hex: 'a'.repeat(64),
      display_name: 'Inviter',
      joined_at: 1,
    })
    useSessionStore.getState().setPeerHello(hostPeerId!, {
      ed_pubkey_hex: 'a'.repeat(64),
      display_name: 'Renamed inviter',
      joined_at: 2,
    })

    expect(authenticatedPeers).toEqual(['a'.repeat(64)])

    await guest.leave()
    useSessionStore.getState().setPeerHello('late-peer', {
      ed_pubkey_hex: 'b'.repeat(64),
      display_name: 'Late peer',
      joined_at: 3,
    })
    expect(authenticatedPeers).toEqual(['a'.repeat(64)])

    await host.leave()
  })
})

describe('mesh hard-cap', () => {
  test('a solo guest rejects delayed invite joins after the original host leaves', async () => {
    const hostStore = createSessionStore()
    const survivorStore = createSessionStore()
    const host = hostSession({ store: hostStore })
    const survivor = joinSession(host.sessionTopic, host.sessionPassword, {
      store: survivorStore,
    })
    await flushMicrotasks()
    expect(survivor.peers()).toHaveLength(1)

    // The last original host may leave while an invited guest keeps studying
    // solo. That is an intended active room, not a 20-second grace period.
    await host.leave()
    expect(survivorStore.getState().status).toBe('active')
    expect(survivor.peers()).toEqual([])

    // Exercise the old survivor-side deadline as well: durable pending
    // invites can arrive after it, and their admission must still be bounded.
    vi.useFakeTimers()
    await vi.advanceTimersByTimeAsync(REJOIN_WINDOW_MS + 1)
    vi.useRealTimers()

    const inviteeStores = Array.from({ length: MAX_REMOTE_PEERS + 1 }, () =>
      createSessionStore()
    )
    const invitees = inviteeStores.map((store) =>
      joinSession(host.sessionTopic, host.sessionPassword, { store })
    )
    await flushMicrotasks(16)
    vi.useFakeTimers()
    await vi.advanceTimersByTimeAsync(ADMISSION_AUTHENTICATION_TIMEOUT_MS)
    vi.useRealTimers()

    // Original-host authority is not transferable. The survivor is protected
    // from every unseen delayed invite, rather than allowing an entrant to
    // become an authority that could evict one of the valid incumbents.
    expect(survivorStore.getState().status).toBe('active')
    expect(survivor.peers()).toEqual([])
    for (const store of inviteeStores) {
      // A guest cannot force local Leave; each delayed client remains locally
      // active but has no authenticated room transport and cannot mesh with
      // the other delayed invites.
      expect(store.getState().status).toBe('active')
      expect(Object.keys(store.getState().peers)).toEqual([])
    }

    await survivor.leave()
    for (const invitee of invitees) await invitee.leave()
  })

  test('hostless incumbents remain active while delayed invitees are rejected', async () => {
    const hostStore = createSessionStore()
    const incumbentStores = Array.from({ length: MAX_REMOTE_PEERS }, () =>
      createSessionStore()
    )
    const host = hostSession({ store: hostStore })
    const incumbents = incumbentStores.map((store) =>
      joinSession(host.sessionTopic, host.sessionPassword, { store })
    )
    await flushMicrotasks(12)

    await host.leave()
    vi.useFakeTimers()
    await vi.advanceTimersByTimeAsync(REJOIN_WINDOW_MS + 1)
    vi.useRealTimers()

    const delayedStores = [createSessionStore(), createSessionStore()]
    const delayed = delayedStores.map((store) =>
      joinSession(host.sessionTopic, host.sessionPassword, { store })
    )
    await flushMicrotasks(16)
    vi.useFakeTimers()
    await vi.advanceTimersByTimeAsync(ADMISSION_AUTHENTICATION_TIMEOUT_MS)
    vi.useRealTimers()

    for (const store of incumbentStores) {
      expect(store.getState().status).toBe('active')
      expect(Object.keys(store.getState().peers)).toHaveLength(
        MAX_REMOTE_PEERS - 1
      )
    }
    for (const store of delayedStores) {
      expect(store.getState().status).toBe('active')
      expect(Object.keys(store.getState().peers)).toEqual([])
    }

    for (const incumbent of incumbents) await incumbent.leave()
    for (const invitee of delayed) await invitee.leave()
  })

  test('a fifth entrant cannot evict anyone from a full four-person mesh', async () => {
    const hostStore = createSessionStore()
    const guestStores = Array.from({ length: MAX_REMOTE_PEERS + 1 }, () =>
      createSessionStore()
    )
    const host = hostSession({ store: hostStore })
    const guests = guestStores.map((store) =>
      joinSession(host.sessionTopic, host.sessionPassword, { store })
    )
    // 4 joiners attempt to connect. The original host owns the only capacity
    // decision, so the fourth joins briefly enough to receive session-full;
    // it never gets to evict the incumbent it sees as a fourth remote peer.
    await flushMicrotasks(12)

    expect(host.peers()).toHaveLength(MAX_REMOTE_PEERS)
    for (const store of [
      hostStore,
      ...guestStores.slice(0, MAX_REMOTE_PEERS),
    ]) {
      expect(store.getState().status).toBe('active')
      expect(Object.keys(store.getState().peers)).toHaveLength(MAX_REMOTE_PEERS)
    }
    expect(guestStores[MAX_REMOTE_PEERS]?.getState().status).toBe('ended')

    // Exactly the rejected fifth auto-left (received 'session-full', then ran
    // its leave handler which upserts one row before explicit cleanup runs).
    const insertCallsBeforeCleanup = invokeMock.mock.calls.filter(
      ([cmd]) => cmd === 'sessions_insert'
    )
    expect(insertCallsBeforeCleanup).toHaveLength(1)

    // Cleanup so rooms don't leak across tests. Each leave is idempotent.
    await host.leave()
    for (const g of guests) await g.leave()
  })

  test('a peer departure frees capacity for a replacement', async () => {
    const host = hostSession()
    const guests = [
      joinSession(host.sessionTopic, host.sessionPassword),
      joinSession(host.sessionTopic, host.sessionPassword),
      joinSession(host.sessionTopic, host.sessionPassword),
    ]
    await flushMicrotasks(8)
    expect(host.peers()).toHaveLength(MAX_REMOTE_PEERS)

    await guests[0].leave()
    await flushMicrotasks()
    expect(host.peers()).toHaveLength(MAX_REMOTE_PEERS - 1)

    const replacement = joinSession(host.sessionTopic, host.sessionPassword)
    await flushMicrotasks(8)
    expect(host.peers()).toHaveLength(MAX_REMOTE_PEERS)
    expect(host.peers()).toContain(replacement.room.selfId)

    await host.leave()
    for (const guest of guests) await guest.leave()
    await replacement.leave()
  })

  test('a report rejoined host reserves pre-leave incumbents against a delayed fifth', async () => {
    const hostStore = createSessionStore()
    const incumbentStores = Array.from({ length: MAX_REMOTE_PEERS }, () =>
      createSessionStore()
    )
    const host = hostSession({ store: hostStore })
    const incumbents = incumbentStores.map((store) =>
      joinSession(host.sessionTopic, host.sessionPassword, { store })
    )
    await flushMicrotasks(12)
    const incumbentIds = incumbents.map((guest) => guest.room.selfId)
    expect(host.peers()).toEqual(incumbentIds)

    await host.leave()
    const request = hostStore.getState().getRejoinRequest()
    expect(request).toMatchObject({
      isHost: true,
      reservedReconnectPeerIds: incumbentIds,
    })

    const rejoined = rejoinSession(
      host.sessionTopic,
      host.sessionPassword,
      true,
      { store: hostStore }
    )
    expect(hostStore.getState().isHost).toBe(true)

    // Existing transports reconnect to the returning original host before a
    // delayed fifth can consume the preserved incumbent reservation.
    const delayed = joinSession(host.sessionTopic, host.sessionPassword, {
      store: createSessionStore(),
    })
    await flushMicrotasks(12)
    expect(rejoined.peers()).toEqual(incumbentIds)
    expect(rejoined.peers()).not.toContain(delayed.room.selfId)

    await rejoined.leave()
    await delayed.leave()
    for (const incumbent of incumbents) await incumbent.leave()
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
          peerPresenceMs: string | null
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
    // Every new writer distinguishes a precisely measured peerless/unknown-
    // hello interval from a legacy row by sending a non-null object.
    expect(args?.peerPresenceMs).toBe('{}')
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

  test('concurrent leave calls persist exactly once', async () => {
    const host = hostSession()
    await flushMicrotasks()

    invokeMock.mockClear()
    invokeMock.mockResolvedValue(undefined)

    const firstLeave = host.leave()
    const duplicateLeave = host.leave()
    expect(duplicateLeave).toBe(firstLeave)
    await Promise.all([firstLeave, duplicateLeave])

    const insertCalls = invokeMock.mock.calls.filter(
      ([cmd]) => cmd === 'sessions_insert'
    )
    expect(insertCalls).toHaveLength(1)
  })

  test('host and guest wrappers keep a preflight failure retryable without disposing admission', async () => {
    const hostStore = createSessionStore()
    const guestStore = createSessionStore()
    const host = hostSession({ store: hostStore })
    const guest = joinSession(host.sessionTopic, host.sessionPassword, {
      store: guestStore,
    })
    await flushMicrotasks()

    for (const [handle, store] of [
      [host, hostStore],
      [guest, guestStore],
    ] as const) {
      const collectPeerPubkeys = store.getState().collectPeerPubkeys
      let failPreflight = true
      store.setState({
        collectPeerPubkeys: () => {
          if (failPreflight) {
            failPreflight = false
            throw new Error('preflight failed')
          }
          return collectPeerPubkeys()
        },
      })

      const first = handle.leave()
      expect(handle.leave()).toBe(first)
      await expect(first).rejects.toThrow('preflight failed')
      expect(store.getState().status).toBe('active')

      const retry = handle.leave()
      expect(retry).not.toBe(first)
      await retry
    }
  })
})
