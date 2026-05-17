// Pomodoro broadcaster + handover. Driven by a hand-rolled in-process bus +
// fake timers so handover detection (10s of broadcaster silence) can be
// triggered deterministically with `vi.advanceTimersByTime` instead of
// real wall-clock waiting.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import {
  HANDOVER_SILENCE_MS,
  POMODORO_ACTION,
  pickNextBroadcaster,
  startPomodoroController,
  type PomodoroSnapshot,
} from '@/features/session/pomodoro'
import type { TopicRoom } from '@/lib/trystero'

type Receiver = (data: unknown, peerId: string) => void

class Bus {
  rooms = new Map<string, BusRoom>()
  // Per-(sender, recipient) counter of pomodoro-namespace messages, used by
  // the handover test to assert Alice goes silent post-disconnect.
  pomodoroSendCounts = new Map<string, number>()

  send(from: string, namespace: string, data: unknown): void {
    for (const r of this.rooms.values()) {
      if (r.peerId === from) continue
      if (r.closed) continue
      if (namespace === POMODORO_ACTION) {
        const key = `${from}->${r.peerId}`
        this.pomodoroSendCounts.set(
          key,
          (this.pomodoroSendCounts.get(key) ?? 0) + 1
        )
      }
      const handlers = r.receivers.get(namespace) ?? []
      for (const h of handlers) h(data, from)
    }
  }
}

class BusRoom {
  peerId: string
  bus: Bus
  receivers = new Map<string, Receiver[]>()
  closed = false

  constructor(bus: Bus, peerId: string) {
    this.bus = bus
    this.peerId = peerId
    bus.rooms.set(peerId, this)
  }

  asTopicRoom(): TopicRoom {
    const peerId = this.peerId
    const bus = this.bus
    const receivers = this.receivers
    const room: Partial<TopicRoom> & { selfId: string } = {
      selfId: peerId,
      makeAction: <T>(namespace: string) => ({
        send: async (data: T): Promise<void[]> => {
          bus.send(peerId, namespace, data)
          return []
        },
        receive: (cb: (data: T, peerId: string) => void) => {
          const list = receivers.get(namespace) ?? []
          list.push(cb as Receiver)
          receivers.set(namespace, list)
        },
      }),
      onPeerJoin: () => () => {},
      onPeerLeave: () => () => {},
      onPeerStream: () => () => {},
      addStream: () => {},
      removeStream: () => {},
      getPeers: () => ({}),
      leave: async () => {},
    }
    return room as TopicRoom
  }
}

const ED = {
  alice: 'aa'.repeat(32),
  bob: 'bb'.repeat(32),
  carol: 'cc'.repeat(32),
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('pickNextBroadcaster', () => {
  test('picks the earliest joined peer, excluding the current broadcaster', () => {
    const peers = [
      { ed_pubkey_hex: ED.alice, joined_at: 100 },
      { ed_pubkey_hex: ED.bob, joined_at: 200 },
      { ed_pubkey_hex: ED.carol, joined_at: 50 },
    ]
    expect(pickNextBroadcaster(peers, ED.carol)).toBe(ED.alice)
  })

  test('breaks ties on equal joined_at by lex ed_pubkey_hex', () => {
    const peers = [
      { ed_pubkey_hex: ED.bob, joined_at: 100 },
      { ed_pubkey_hex: ED.alice, joined_at: 100 },
    ]
    expect(pickNextBroadcaster(peers, null)).toBe(ED.alice)
  })

  test('returns null when no eligible peer remains', () => {
    expect(
      pickNextBroadcaster([{ ed_pubkey_hex: ED.alice, joined_at: 1 }], ED.alice)
    ).toBeNull()
  })
})

describe('pomodoro broadcaster handover on disconnect', () => {
  test('next-oldest peer takes over within ~10s when broadcaster goes silent', async () => {
    const bus = new Bus()
    const aliceRoom = new BusRoom(bus, 'peer-a')
    const bobRoom = new BusRoom(bus, 'peer-b')
    const carolRoom = new BusRoom(bus, 'peer-c')

    // Stable join order: alice@1000, bob@2000, carol@3000.
    const aliceJoinedAt = 1_000
    const bobJoinedAt = 2_000
    const carolJoinedAt = 3_000

    const peerList = [
      { ed_pubkey_hex: ED.alice, joined_at: aliceJoinedAt },
      { ed_pubkey_hex: ED.bob, joined_at: bobJoinedAt },
      { ed_pubkey_hex: ED.carol, joined_at: carolJoinedAt },
    ]

    const senderEd: Record<string, string> = {
      'peer-a': ED.alice,
      'peer-b': ED.bob,
      'peer-c': ED.carol,
    }
    const resolveSenderEdPubkey = (peerId: string): string | null =>
      senderEd[peerId] ?? null

    const aliceSnaps: PomodoroSnapshot[] = []
    const bobSnaps: PomodoroSnapshot[] = []
    const carolSnaps: PomodoroSnapshot[] = []

    const alice = startPomodoroController({
      room: aliceRoom.asTopicRoom(),
      myEdPubkeyHex: ED.alice,
      selfJoinedAt: aliceJoinedAt,
      getAllPeerOrdering: () => peerList,
      resolveSenderEdPubkey,
      onSnapshot: (s) => aliceSnaps.push(s),
      onPomodoroStart: () => {},
      onPomodoroEnd: () => {},
    })
    const bob = startPomodoroController({
      room: bobRoom.asTopicRoom(),
      myEdPubkeyHex: ED.bob,
      selfJoinedAt: bobJoinedAt,
      getAllPeerOrdering: () => peerList,
      resolveSenderEdPubkey,
      onSnapshot: (s) => bobSnaps.push(s),
      onPomodoroStart: () => {},
      onPomodoroEnd: () => {},
    })
    const carol = startPomodoroController({
      room: carolRoom.asTopicRoom(),
      myEdPubkeyHex: ED.carol,
      selfJoinedAt: carolJoinedAt,
      getAllPeerOrdering: () => peerList,
      resolveSenderEdPubkey,
      onSnapshot: (s) => carolSnaps.push(s),
      onPomodoroStart: () => {},
      onPomodoroEnd: () => {},
    })

    // Alice (broadcaster) starts a 25/5 work phase at t = 10s. The first
    // tick + first phase-transition timer are scheduled inside start();
    // bus delivery is synchronous so receivers see the message before any
    // timer would fire. We deliberately do NOT use runOnlyPendingTimers
    // here — that would also fire the 25-minute phase-transition timeout.
    vi.setSystemTime(10_000)
    alice.start('25/5')

    const aliceFirst = lastSnapshot(aliceSnaps)
    expect(aliceFirst.iAmBroadcaster).toBe(true)
    expect(aliceFirst.phase).toBe('work-25')
    const initialEndsAt = aliceFirst.endsAt
    expect(initialEndsAt).toBe(10_000 + 25 * 60_000)

    // Bob + Carol receive Alice's first broadcast.
    expect(lastSnapshot(bobSnaps).broadcasterEdPubkey).toBe(ED.alice)
    expect(lastSnapshot(bobSnaps).endsAt).toBe(initialEndsAt)
    expect(lastSnapshot(carolSnaps).broadcasterEdPubkey).toBe(ED.alice)
    expect(lastSnapshot(carolSnaps).endsAt).toBe(initialEndsAt)

    const bobTicksBefore = bus.pomodoroSendCounts.get('peer-a->peer-b') ?? 0
    const carolTicksBefore = bus.pomodoroSendCounts.get('peer-a->peer-c') ?? 0
    expect(bobTicksBefore).toBeGreaterThanOrEqual(1)
    expect(carolTicksBefore).toBeGreaterThanOrEqual(1)

    // Alice's process drops off the network: close her room (further sends
    // from her are dropped) AND tear down her controller so she stops
    // re-arming the 5s broadcast interval.
    aliceRoom.closed = true
    alice.teardown()

    // Advance just past the 10s silence window. Bob is the next-oldest
    // peer (joined_at 2000); he should take over and resume broadcasting
    // from the original ends_at — no reset.
    vi.setSystemTime(10_000 + HANDOVER_SILENCE_MS + 100)
    await vi.advanceTimersByTimeAsync(HANDOVER_SILENCE_MS + 100)

    const bobAfter = lastSnapshot(bobSnaps)
    expect(bobAfter.iAmBroadcaster).toBe(true)
    expect(bobAfter.broadcasterEdPubkey).toBe(ED.bob)
    expect(bobAfter.endsAt).toBe(initialEndsAt)
    expect(bobAfter.phase).toBe('work-25')

    // Carol observes the new broadcaster on Bob's first post-handover tick.
    const carolAfter = lastSnapshot(carolSnaps)
    expect(carolAfter.broadcasterEdPubkey).toBe(ED.bob)
    expect(carolAfter.endsAt).toBe(initialEndsAt)

    // Confirm Alice didn't keep delivering messages after disconnect (her
    // closed room blocks Bus.send from forwarding any further sends).
    expect(bus.pomodoroSendCounts.get('peer-a->peer-b') ?? 0).toBe(
      bobTicksBefore
    )
    expect(bus.pomodoroSendCounts.get('peer-a->peer-c') ?? 0).toBe(
      carolTicksBefore
    )

    bob.teardown()
    carol.teardown()
  })
})

describe('pomodoro deliberate stop propagates (regression: I1)', () => {
  test('broadcaster stop() resets receivers to idle; no handover fires', async () => {
    const bus = new Bus()
    const aliceRoom = new BusRoom(bus, 'peer-a')
    const bobRoom = new BusRoom(bus, 'peer-b')

    const peerList = [
      { ed_pubkey_hex: ED.alice, joined_at: 1_000 },
      { ed_pubkey_hex: ED.bob, joined_at: 2_000 },
    ]
    const senderEd: Record<string, string> = {
      'peer-a': ED.alice,
      'peer-b': ED.bob,
    }
    const resolveSenderEdPubkey = (peerId: string): string | null =>
      senderEd[peerId] ?? null

    const aliceSnaps: PomodoroSnapshot[] = []
    const bobSnaps: PomodoroSnapshot[] = []

    const alice = startPomodoroController({
      room: aliceRoom.asTopicRoom(),
      myEdPubkeyHex: ED.alice,
      selfJoinedAt: 1_000,
      getAllPeerOrdering: () => peerList,
      resolveSenderEdPubkey,
      onSnapshot: (s) => aliceSnaps.push(s),
      onPomodoroStart: () => {},
      onPomodoroEnd: () => {},
    })
    const bob = startPomodoroController({
      room: bobRoom.asTopicRoom(),
      myEdPubkeyHex: ED.bob,
      selfJoinedAt: 2_000,
      getAllPeerOrdering: () => peerList,
      resolveSenderEdPubkey,
      onSnapshot: (s) => bobSnaps.push(s),
      onPomodoroStart: () => {},
      onPomodoroEnd: () => {},
    })

    vi.setSystemTime(10_000)
    alice.start('25/5')
    expect(lastSnapshot(bobSnaps).phase).toBe('work-25')
    expect(lastSnapshot(bobSnaps).broadcasterEdPubkey).toBe(ED.alice)

    // Alice deliberately stops. Bob must go idle immediately on the stop
    // message — NOT resurrect the timer when the silence window elapses.
    alice.stop()
    const bobAfterStop = lastSnapshot(bobSnaps)
    expect(bobAfterStop.phase).toBe('idle')
    expect(bobAfterStop.iAmBroadcaster).toBe(false)
    expect(bobAfterStop.broadcasterEdPubkey).toBeNull()

    // Past the handover window: pre-fix, Bob's silence timer fired here and
    // he seized the broadcaster role. Post-fix, he stays idle.
    vi.setSystemTime(10_000 + HANDOVER_SILENCE_MS + 100)
    await vi.advanceTimersByTimeAsync(HANDOVER_SILENCE_MS + 100)
    const bobFinal = lastSnapshot(bobSnaps)
    expect(bobFinal.phase).toBe('idle')
    expect(bobFinal.iAmBroadcaster).toBe(false)

    alice.teardown()
    bob.teardown()
  })
})

function lastSnapshot(arr: PomodoroSnapshot[]): PomodoroSnapshot {
  if (arr.length === 0) throw new Error('expected at least one snapshot')
  return arr[arr.length - 1]
}
