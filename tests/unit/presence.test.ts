import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('@/lib/trystero', () => {
  type Listener = (peerId: string) => void
  type Receiver = (data: unknown, peerId: string) => void
  type Bus = { rooms: Map<string, BusRoom> }
  type BusRoom = {
    peerId: string
    onJoin: Listener[]
    onLeave: Listener[]
    receivers: Map<string, Receiver[]>
    left: boolean
  }
  const buses = new Map<string, Bus>()
  const joinConfigs: Array<Record<string, unknown>> = []
  let nextPeer = 0

  function getBus(key: string): Bus {
    let bus = buses.get(key)
    if (!bus) {
      bus = { rooms: new Map() }
      buses.set(key, bus)
    }
    return bus
  }

  function joinTopic(
    config: { topic: string; password: string } & Record<string, unknown>
  ) {
    joinConfigs.push(config)
    const { topic, password } = config
    const key = `${topic}|${password}`
    const bus = getBus(key)
    const peerId = `peer-${++nextPeer}`
    const room: BusRoom = {
      peerId,
      onJoin: [],
      onLeave: [],
      receivers: new Map(),
      left: false,
    }
    bus.rooms.set(peerId, room)
    return {
      makeAction<T>(namespace: string) {
        const send = async (data: T): Promise<void> => {
          for (const other of bus.rooms.values()) {
            if (other === room || other.left) continue
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
      leave: async () => {
        room.left = true
        bus.rooms.delete(peerId)
      },
    }
  }
  return {
    joinTopic,
    __resetBus: () => {
      buses.clear()
      joinConfigs.length = 0
    },
    __getJoinConfigs: () => joinConfigs,
  }
})

import { generateIdentity, bytesToHex } from '@/lib/crypto/identity'
import {
  isOnline,
  LIMITED_CONNECTION_SETTLE_MS,
  ONLINE_WINDOW_MS,
  presenceState,
  startPresence,
  type PresenceMap,
  type PresenceRelayHandle,
  type PresenceRelayOptions,
} from '@/features/friends'

beforeEach(async () => {
  const mod = (await import('@/lib/trystero')) as unknown as {
    __resetBus: () => void
  }
  mod.__resetBus()
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('isOnline', () => {
  test('true when last heartbeat is within ONLINE_WINDOW_MS', () => {
    const now = 1_700_000_000_000
    const map: PresenceMap = {
      friend: { lastSeenAt: now - 10_000, onlineSince: now - 10_000 },
    }
    expect(isOnline(map, 'friend', now)).toBe(true)
  })
  test('false when last heartbeat is past ONLINE_WINDOW_MS', () => {
    const now = 1_700_000_000_000
    const map: PresenceMap = {
      friend: {
        lastSeenAt: now - (ONLINE_WINDOW_MS + 1),
        onlineSince: now - (ONLINE_WINDOW_MS + 1),
      },
    }
    expect(isOnline(map, 'friend', now)).toBe(false)
  })
  test('false when friend has no recorded heartbeat', () => {
    expect(isOnline({}, 'friend', 0)).toBe(false)
  })
  test('false after a goodbye even inside the window (left flag)', () => {
    const now = 1_700_000_000_000
    const map: PresenceMap = {
      friend: { lastSeenAt: now - 1_000, onlineSince: now - 1_000, left: true },
    }
    expect(isOnline(map, 'friend', now)).toBe(false)
  })
})

// I74 — the richer state the friends list renders from.
describe('presenceState', () => {
  const now = 1_700_000_000_000
  test('offline with no entry carries a null lastSeenAt', () => {
    expect(presenceState({}, 'friend', now)).toEqual({
      state: 'offline',
      lastSeenAt: null,
    })
  })
  test('offline past the window keeps lastSeenAt for "seen … ago"', () => {
    const last = now - (ONLINE_WINDOW_MS + 5_000)
    const map: PresenceMap = {
      friend: { lastSeenAt: last, onlineSince: last },
    }
    expect(presenceState(map, 'friend', now)).toEqual({
      state: 'offline',
      lastSeenAt: last,
    })
  })
  test('offline after a goodbye keeps lastSeenAt', () => {
    const last = now - 1_000
    const map: PresenceMap = {
      friend: { lastSeenAt: last, onlineSince: last, left: true },
    }
    expect(presenceState(map, 'friend', now)).toEqual({
      state: 'offline',
      lastSeenAt: last,
    })
  })
  test('online with a recent P2P heartbeat is not limited', () => {
    const map: PresenceMap = {
      friend: {
        lastSeenAt: now - 5_000,
        lastP2pAt: now - 5_000,
        onlineSince: now - LIMITED_CONNECTION_SETTLE_MS * 3,
      },
    }
    expect(presenceState(map, 'friend', now)).toEqual({
      state: 'online',
      limited: false,
    })
  })
  test('relay-only online is not limited inside the settle window', () => {
    const map: PresenceMap = {
      friend: {
        lastSeenAt: now - 5_000,
        onlineSince: now - (LIMITED_CONNECTION_SETTLE_MS - 1_000),
      },
    }
    expect(presenceState(map, 'friend', now)).toEqual({
      state: 'online',
      limited: false,
    })
  })
  test('relay-only online past the settle window is limited', () => {
    const map: PresenceMap = {
      friend: {
        lastSeenAt: now - 5_000,
        onlineSince: now - (LIMITED_CONNECTION_SETTLE_MS + 1_000),
      },
    }
    expect(presenceState(map, 'friend', now)).toEqual({
      state: 'online',
      limited: true,
    })
  })
  test('a stale P2P stamp inside a live streak no longer counts as direct', () => {
    const map: PresenceMap = {
      friend: {
        lastSeenAt: now - 5_000,
        lastP2pAt: now - (ONLINE_WINDOW_MS + 10_000),
        onlineSince: now - LIMITED_CONNECTION_SETTLE_MS * 3,
      },
    }
    expect(presenceState(map, 'friend', now)).toEqual({
      state: 'online',
      limited: true,
    })
  })
})

describe('startPresence goodbye (F7)', () => {
  test('a goodbye flips the friend offline immediately on receipt', async () => {
    const me = generateIdentity()
    const friend = generateIdentity()
    const meHex = bytesToHex(me.edPub)
    const friendHex = bytesToHex(friend.edPub)

    const myMaps: PresenceMap[] = []
    const myPresence = startPresence({
      myEdPubkey: me.edPub,
      friends: [{ ed_pubkey_hex: friendHex }],
      onPresenceChange: (m) => myMaps.push(m),
      intervalMs: 60_000,
      sweepIntervalMs: 60_000,
      makeRelay: null,
    })
    // The friend runs their own presence daemon (sends heartbeats on THEIR
    // topic, which `me` subscribes to).
    const friendPresence = startPresence({
      myEdPubkey: friend.edPub,
      friends: [{ ed_pubkey_hex: meHex }],
      onPresenceChange: () => {},
      intervalMs: 60_000,
      sweepIntervalMs: 60_000,
      makeRelay: null,
    })

    // Flush the immediate first heartbeat both sides send on start.
    await vi.advanceTimersByTimeAsync(0)
    const afterHeartbeat = myMaps.at(-1) ?? {}
    expect(afterHeartbeat[friendHex]?.lastSeenAt).toBeTypeOf('number')
    // A datachannel heartbeat proves the direct leg.
    expect(afterHeartbeat[friendHex]?.lastP2pAt).toBeTypeOf('number')

    // Friend says goodbye → offline this instant, but last-seen survives.
    friendPresence.sendGoodbye()
    await vi.advanceTimersByTimeAsync(0)
    const afterGoodbye = myMaps.at(-1) ?? {}
    expect(afterGoodbye[friendHex]?.left).toBe(true)
    expect(isOnline(afterGoodbye, friendHex)).toBe(false)
    expect(afterGoodbye[friendHex]?.lastSeenAt).toBeTypeOf('number')

    await myPresence.leave()
    await friendPresence.leave()
  })

  test('leave() broadcasts a goodbye before tearing the rooms down', async () => {
    const me = generateIdentity()
    const friend = generateIdentity()
    const meHex = bytesToHex(me.edPub)
    const friendHex = bytesToHex(friend.edPub)

    const myMaps: PresenceMap[] = []
    const myPresence = startPresence({
      myEdPubkey: me.edPub,
      friends: [{ ed_pubkey_hex: friendHex }],
      onPresenceChange: (m) => myMaps.push(m),
      intervalMs: 60_000,
      sweepIntervalMs: 60_000,
      makeRelay: null,
    })
    const friendPresence = startPresence({
      myEdPubkey: friend.edPub,
      friends: [{ ed_pubkey_hex: meHex }],
      onPresenceChange: () => {},
      intervalMs: 60_000,
      sweepIntervalMs: 60_000,
      makeRelay: null,
    })

    await vi.advanceTimersByTimeAsync(0)
    expect((myMaps.at(-1) ?? {})[friendHex]?.lastSeenAt).toBeTypeOf('number')

    await friendPresence.leave()
    await vi.advanceTimersByTimeAsync(0)
    expect((myMaps.at(-1) ?? {})[friendHex]?.left).toBe(true)
    expect(isOnline(myMaps.at(-1) ?? {}, friendHex)).toBe(false)

    await myPresence.leave()
  })
})

describe('startPresence sweep', () => {
  test('re-emits the presence map on a sweep tick so the UI re-evaluates isOnline', async () => {
    const me = generateIdentity()
    const friend = generateIdentity()
    const friendHex = bytesToHex(friend.edPub)

    const onPresenceChange = vi.fn()
    const presence = startPresence({
      myEdPubkey: me.edPub,
      friends: [{ ed_pubkey_hex: friendHex }],
      onPresenceChange,
      intervalMs: 60_000,
      sweepIntervalMs: 100,
      makeRelay: null,
    })

    // No heartbeats yet → no onPresenceChange from receive path.
    const initialCalls = onPresenceChange.mock.calls.length
    expect(initialCalls).toBe(0)

    // Two sweeps fire in 250ms.
    await vi.advanceTimersByTimeAsync(250)
    expect(onPresenceChange.mock.calls.length).toBeGreaterThanOrEqual(2)
    // Each sweep emits a (still-empty) snapshot of presence.
    expect(onPresenceChange.mock.calls.at(-1)?.[0]).toEqual({})

    await presence.leave()
  })
})

// #47 C6 (I49) — incremental friend churn: only the changed friend's room
// joins/leaves; the own room (and therefore the goodbye broadcast) stays
// untouched, so a list edit can no longer flicker our dot on friends'
// screens.
describe('startPresence updateFriends (#47 C6)', () => {
  test('an added friend starts resolving without touching the own room', async () => {
    const me = generateIdentity()
    const friend = generateIdentity()
    const watcher = generateIdentity()
    const meHex = bytesToHex(me.edPub)
    const friendHex = bytesToHex(friend.edPub)

    // Watcher subscribes to MY presence topic — the flicker detector: any
    // goodbye from my own room would drop me from their map.
    const watcherMaps: PresenceMap[] = []
    const watcherPresence = startPresence({
      myEdPubkey: watcher.edPub,
      friends: [{ ed_pubkey_hex: meHex }],
      onPresenceChange: (m) => watcherMaps.push(m),
      intervalMs: 60_000,
      sweepIntervalMs: 60_000,
      makeRelay: null,
    })

    const myMaps: PresenceMap[] = []
    const myPresence = startPresence({
      myEdPubkey: me.edPub,
      friends: [],
      onPresenceChange: (m) => myMaps.push(m),
      intervalMs: 60_000,
      sweepIntervalMs: 60_000,
      makeRelay: null,
    })
    await vi.advanceTimersByTimeAsync(0)
    expect((watcherMaps.at(-1) ?? {})[meHex]?.lastSeenAt).toBeTypeOf('number')

    // Add the friend AFTER subscribing; their next heartbeat must land.
    myPresence.updateFriends([{ ed_pubkey_hex: friendHex }])
    const friendPresence = startPresence({
      myEdPubkey: friend.edPub,
      friends: [],
      onPresenceChange: () => {},
      intervalMs: 60_000,
      sweepIntervalMs: 60_000,
      makeRelay: null,
    })
    await vi.advanceTimersByTimeAsync(0)
    expect((myMaps.at(-1) ?? {})[friendHex]?.lastSeenAt).toBeTypeOf('number')

    // The watcher never saw us drop: no goodbye crossed the own room.
    expect(
      watcherMaps.every((m) => m[meHex] !== undefined && m[meHex].left !== true)
    ).toBe(true)

    await myPresence.leave()
    await friendPresence.leave()
    await watcherPresence.leave()
  })

  test('a removed friend is dropped from the map immediately and stops resolving', async () => {
    const me = generateIdentity()
    const friend = generateIdentity()
    const friendHex = bytesToHex(friend.edPub)

    const myMaps: PresenceMap[] = []
    const myPresence = startPresence({
      myEdPubkey: me.edPub,
      friends: [{ ed_pubkey_hex: friendHex }],
      onPresenceChange: (m) => myMaps.push(m),
      intervalMs: 60_000,
      sweepIntervalMs: 60_000,
      makeRelay: null,
    })
    const friendPresence = startPresence({
      myEdPubkey: friend.edPub,
      friends: [],
      onPresenceChange: () => {},
      intervalMs: 60_000,
      sweepIntervalMs: 60_000,
      makeRelay: null,
    })
    await vi.advanceTimersByTimeAsync(0)
    expect((myMaps.at(-1) ?? {})[friendHex]?.lastSeenAt).toBeTypeOf('number')

    myPresence.updateFriends([])
    expect((myMaps.at(-1) ?? {})[friendHex]).toBeUndefined()

    // Their later heartbeats no longer land (room left).
    await vi.advanceTimersByTimeAsync(60_000)
    expect((myMaps.at(-1) ?? {})[friendHex]).toBeUndefined()

    await myPresence.leave()
    await friendPresence.leave()
  })

  test('updateFriends with the same set is a no-op', async () => {
    const me = generateIdentity()
    const friend = generateIdentity()
    const friendHex = bytesToHex(friend.edPub)

    const myMaps: PresenceMap[] = []
    const myPresence = startPresence({
      myEdPubkey: me.edPub,
      friends: [{ ed_pubkey_hex: friendHex }],
      onPresenceChange: (m) => myMaps.push(m),
      intervalMs: 60_000,
      sweepIntervalMs: 60_000,
      makeRelay: null,
    })
    const friendPresence = startPresence({
      myEdPubkey: friend.edPub,
      friends: [],
      onPresenceChange: () => {},
      intervalMs: 60_000,
      sweepIntervalMs: 60_000,
      makeRelay: null,
    })
    await vi.advanceTimersByTimeAsync(0)
    expect((myMaps.at(-1) ?? {})[friendHex]?.lastSeenAt).toBeTypeOf('number')

    // Same set → the friend's room must survive (their heartbeats keep landing).
    myPresence.updateFriends([{ ed_pubkey_hex: friendHex }])
    await vi.advanceTimersByTimeAsync(60_000)
    expect((myMaps.at(-1) ?? {})[friendHex]?.lastSeenAt).toBeTypeOf('number')

    await myPresence.leave()
    await friendPresence.leave()
  })
})

// I74 — the relay leg: presence must work when the WebRTC datachannel leg
// cannot form at all (the no-TURN symmetric-NAT case that showed a mutually
// added friend permanently offline on both ends).
describe('startPresence relay leg (I74)', () => {
  type FakeRelay = {
    handle: PresenceRelayHandle
    opts: PresenceRelayOptions
    heartbeats: number
    goodbyes: number
    friendSets: string[][]
    closed: boolean
  }

  function makeFakeRelay(): {
    make: (opts: PresenceRelayOptions) => PresenceRelayHandle
    get: () => FakeRelay
  } {
    let fake: FakeRelay | null = null
    return {
      make: (opts) => {
        const state: FakeRelay = {
          opts,
          heartbeats: 0,
          goodbyes: 0,
          friendSets: [],
          closed: false,
          handle: {
            publishHeartbeat: () => {
              state.heartbeats += 1
            },
            publishGoodbye: () => {
              state.goodbyes += 1
            },
            setFriends: (edHexes) => {
              state.friendSets.push([...edHexes])
            },
            close: () => {
              state.closed = true
            },
          },
        }
        fake = state
        return state.handle
      },
      get: () => {
        if (!fake) throw new Error('relay never constructed')
        return fake
      },
    }
  }

  test('a relay heartbeat stamps the friend online without any datachannel', async () => {
    const me = generateIdentity()
    const friend = generateIdentity()
    const friendHex = bytesToHex(friend.edPub)
    const relay = makeFakeRelay()

    const maps: PresenceMap[] = []
    const presence = startPresence({
      myEdPubkey: me.edPub,
      friends: [{ ed_pubkey_hex: friendHex }],
      onPresenceChange: (m) => maps.push(m),
      intervalMs: 60_000,
      sweepIntervalMs: 60_000,
      makeRelay: relay.make,
    })

    // No friend presence daemon exists — the trystero leg is silent.
    relay.get().opts.onFriendPayload(friendHex, { v: 1 })
    const map = maps.at(-1) ?? {}
    expect(isOnline(map, friendHex)).toBe(true)
    // Relay stamps must never claim the direct leg.
    expect(map[friendHex]?.lastP2pAt).toBeUndefined()

    await presence.leave()
  })

  test('relay goodbye flips the friend offline and keeps last-seen', async () => {
    const me = generateIdentity()
    const friend = generateIdentity()
    const friendHex = bytesToHex(friend.edPub)
    const relay = makeFakeRelay()

    const maps: PresenceMap[] = []
    const presence = startPresence({
      myEdPubkey: me.edPub,
      friends: [{ ed_pubkey_hex: friendHex }],
      onPresenceChange: (m) => maps.push(m),
      intervalMs: 60_000,
      sweepIntervalMs: 60_000,
      makeRelay: relay.make,
    })

    relay.get().opts.onFriendPayload(friendHex, { v: 1 })
    relay.get().opts.onFriendPayload(friendHex, { v: 1, leaving: true })
    const map = maps.at(-1) ?? {}
    expect(isOnline(map, friendHex)).toBe(false)
    expect(map[friendHex]?.lastSeenAt).toBeTypeOf('number')

    await presence.leave()
  })

  test('payloads for a non-friend (or removed friend) are ignored', async () => {
    const me = generateIdentity()
    const friend = generateIdentity()
    const friendHex = bytesToHex(friend.edPub)
    const relay = makeFakeRelay()

    const maps: PresenceMap[] = []
    const presence = startPresence({
      myEdPubkey: me.edPub,
      friends: [{ ed_pubkey_hex: friendHex }],
      onPresenceChange: (m) => maps.push(m),
      intervalMs: 60_000,
      sweepIntervalMs: 60_000,
      makeRelay: relay.make,
    })

    relay.get().opts.onFriendPayload('feed'.repeat(16), { v: 1 })
    expect(maps.length).toBe(0)

    presence.updateFriends([])
    // An in-flight event for the just-removed friend must not resurrect them.
    relay.get().opts.onFriendPayload(friendHex, { v: 1 })
    expect((maps.at(-1) ?? {})[friendHex]).toBeUndefined()

    await presence.leave()
  })

  test('heartbeat tick, goodbye, friend churn, and leave all reach the relay', async () => {
    const me = generateIdentity()
    const friend = generateIdentity()
    const other = generateIdentity()
    const friendHex = bytesToHex(friend.edPub)
    const otherHex = bytesToHex(other.edPub)
    const relay = makeFakeRelay()

    const presence = startPresence({
      myEdPubkey: me.edPub,
      friends: [{ ed_pubkey_hex: friendHex }],
      onPresenceChange: () => {},
      intervalMs: 1_000,
      sweepIntervalMs: 60_000,
      makeRelay: relay.make,
    })

    // Immediate first beat + one interval tick.
    expect(relay.get().heartbeats).toBe(1)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(relay.get().heartbeats).toBe(2)

    // Seed sync then churn: each update lands one setFriends call.
    expect(relay.get().friendSets.at(0)).toEqual([friendHex])
    presence.updateFriends([
      { ed_pubkey_hex: friendHex },
      { ed_pubkey_hex: otherHex },
    ])
    expect(relay.get().friendSets.at(-1)?.sort()).toEqual(
      [friendHex, otherHex].sort()
    )
    presence.updateFriends([{ ed_pubkey_hex: otherHex }])
    expect(relay.get().friendSets.at(-1)).toEqual([otherHex])

    presence.sendGoodbye()
    expect(relay.get().goodbyes).toBe(1)

    await presence.leave()
    // leave() sends a final goodbye, then closes the pool.
    expect(relay.get().goodbyes).toBe(2)
    expect(relay.get().closed).toBe(true)
  })

  test('a relay-only friend upgrades to direct when a datachannel heartbeat lands', async () => {
    const me = generateIdentity()
    const friend = generateIdentity()
    const meHex = bytesToHex(me.edPub)
    const friendHex = bytesToHex(friend.edPub)
    const relay = makeFakeRelay()

    const maps: PresenceMap[] = []
    const presence = startPresence({
      myEdPubkey: me.edPub,
      friends: [{ ed_pubkey_hex: friendHex }],
      onPresenceChange: (m) => maps.push(m),
      intervalMs: 60_000,
      sweepIntervalMs: 60_000,
      makeRelay: relay.make,
    })

    relay.get().opts.onFriendPayload(friendHex, { v: 1 })
    expect((maps.at(-1) ?? {})[friendHex]?.lastP2pAt).toBeUndefined()

    // Friend's trystero heartbeat arrives (mock bus) → direct proven.
    const friendPresence = startPresence({
      myEdPubkey: friend.edPub,
      friends: [{ ed_pubkey_hex: meHex }],
      onPresenceChange: () => {},
      intervalMs: 60_000,
      sweepIntervalMs: 60_000,
      makeRelay: null,
    })
    await vi.advanceTimersByTimeAsync(0)
    expect((maps.at(-1) ?? {})[friendHex]?.lastP2pAt).toBeTypeOf('number')

    await presence.leave()
    await friendPresence.leave()
  })
})

// The presence datachannels need the user's TURN server on strict NATs just
// like sessions do — a STUN-only presence room shows every friend permanently
// offline for exactly the user who configured TURN to fix that network.
describe('startPresence TURN forwarding', () => {
  test('own and friend rooms carry the configured TURN server', async () => {
    const { useSettingsStore } = await import('@/stores/settingsStore')
    const prevValues = useSettingsStore.getState().values
    useSettingsStore.setState({
      values: {
        ...prevValues,
        turnPreference: 'auto',
        turnServer: {
          url: 'turn:turn.example.test:3478',
          username: 'u',
          credential: 'c',
        },
      },
    })
    try {
      const me = generateIdentity()
      const friend = generateIdentity()
      const presence = startPresence({
        myEdPubkey: me.edPub,
        friends: [{ ed_pubkey_hex: bytesToHex(friend.edPub) }],
        onPresenceChange: () => {},
        intervalMs: 60_000,
        sweepIntervalMs: 60_000,
        makeRelay: null,
      })
      const mod = (await import('@/lib/trystero')) as unknown as {
        __getJoinConfigs: () => Array<Record<string, unknown>>
      }
      const configs = mod.__getJoinConfigs()
      expect(configs.length).toBe(2) // own room + one friend room
      for (const config of configs) {
        expect(config.turnConfig).toEqual([
          {
            urls: 'turn:turn.example.test:3478',
            username: 'u',
            credential: 'c',
          },
        ])
      }
      await presence.leave()
    } finally {
      useSettingsStore.setState({ values: prevValues })
    }
  })
})
