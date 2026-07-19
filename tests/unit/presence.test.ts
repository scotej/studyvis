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
        const send = async (data: T): Promise<void[]> => {
          for (const other of bus.rooms.values()) {
            if (other === room || other.left) continue
            const handlers = other.receivers.get(namespace) ?? []
            for (const h of handlers) h(data, room.peerId)
          }
          return []
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
  ONLINE_WINDOW_MS,
  startPresence,
  type PresenceMap,
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
    const map: PresenceMap = { friend: now - 10_000 }
    expect(isOnline(map, 'friend', now)).toBe(true)
  })
  test('false when last heartbeat is past ONLINE_WINDOW_MS', () => {
    const now = 1_700_000_000_000
    const map: PresenceMap = { friend: now - (ONLINE_WINDOW_MS + 1) }
    expect(isOnline(map, 'friend', now)).toBe(false)
  })
  test('false when friend has no recorded heartbeat', () => {
    expect(isOnline({}, 'friend', 0)).toBe(false)
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
    })
    // The friend runs their own presence daemon (sends heartbeats on THEIR
    // topic, which `me` subscribes to).
    const friendPresence = startPresence({
      myEdPubkey: friend.edPub,
      friends: [{ ed_pubkey_hex: meHex }],
      onPresenceChange: () => {},
      intervalMs: 60_000,
      sweepIntervalMs: 60_000,
    })

    // Flush the immediate first heartbeat both sides send on start.
    await vi.advanceTimersByTimeAsync(0)
    const afterHeartbeat = myMaps.at(-1) ?? {}
    expect(typeof afterHeartbeat[friendHex]).toBe('number')

    // Friend says goodbye → my map should drop them this instant.
    friendPresence.sendGoodbye()
    await vi.advanceTimersByTimeAsync(0)
    const afterGoodbye = myMaps.at(-1) ?? {}
    expect(afterGoodbye[friendHex]).toBeUndefined()

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
    })
    const friendPresence = startPresence({
      myEdPubkey: friend.edPub,
      friends: [{ ed_pubkey_hex: meHex }],
      onPresenceChange: () => {},
      intervalMs: 60_000,
      sweepIntervalMs: 60_000,
    })

    await vi.advanceTimersByTimeAsync(0)
    expect(typeof (myMaps.at(-1) ?? {})[friendHex]).toBe('number')

    await friendPresence.leave()
    await vi.advanceTimersByTimeAsync(0)
    expect((myMaps.at(-1) ?? {})[friendHex]).toBeUndefined()

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
    })

    const myMaps: PresenceMap[] = []
    const myPresence = startPresence({
      myEdPubkey: me.edPub,
      friends: [],
      onPresenceChange: (m) => myMaps.push(m),
      intervalMs: 60_000,
      sweepIntervalMs: 60_000,
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(typeof (watcherMaps.at(-1) ?? {})[meHex]).toBe('number')

    // Add the friend AFTER subscribing; their next heartbeat must land.
    myPresence.updateFriends([{ ed_pubkey_hex: friendHex }])
    const friendPresence = startPresence({
      myEdPubkey: friend.edPub,
      friends: [],
      onPresenceChange: () => {},
      intervalMs: 60_000,
      sweepIntervalMs: 60_000,
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(typeof (myMaps.at(-1) ?? {})[friendHex]).toBe('number')

    // The watcher never saw us drop: no goodbye crossed the own room.
    expect(watcherMaps.every((m) => typeof m[meHex] === 'number')).toBe(true)

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
    })
    const friendPresence = startPresence({
      myEdPubkey: friend.edPub,
      friends: [],
      onPresenceChange: () => {},
      intervalMs: 60_000,
      sweepIntervalMs: 60_000,
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(typeof (myMaps.at(-1) ?? {})[friendHex]).toBe('number')

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
    })
    const friendPresence = startPresence({
      myEdPubkey: friend.edPub,
      friends: [],
      onPresenceChange: () => {},
      intervalMs: 60_000,
      sweepIntervalMs: 60_000,
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(typeof (myMaps.at(-1) ?? {})[friendHex]).toBe('number')

    // Same set → the friend's room must survive (their heartbeats keep landing).
    myPresence.updateFriends([{ ed_pubkey_hex: friendHex }])
    await vi.advanceTimersByTimeAsync(60_000)
    expect(typeof (myMaps.at(-1) ?? {})[friendHex]).toBe('number')

    await myPresence.leave()
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
