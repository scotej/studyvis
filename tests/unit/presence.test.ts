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
  let nextPeer = 0

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
  return { joinTopic, __resetBus: () => buses.clear() }
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
