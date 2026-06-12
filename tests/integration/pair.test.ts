import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import {
  bytesToHex,
  generateIdentity,
  signMessage,
} from '@/lib/crypto/identity'

vi.mock('@/lib/trystero', () => {
  type Listener = (peerId: string) => void
  type Receiver = (data: unknown, peerId: string) => void
  type Bus = {
    rooms: Map<string, BusRoom>
  }
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

    // Each room schedules a microtask after join; the second arrival fires the
    // pair onPeerJoin twice (once from its own microtask, once from the first
    // room's). Real trystero fires once. pair.ts's `settled` guard handles it.
    queueMicrotask(() => {
      if (room.left) return
      for (const other of bus.rooms.values()) {
        if (other === room || other.left) continue
        for (const fn of room.onJoin) fn(other.peerId)
        for (const fn of other.onJoin) fn(room.peerId)
      }
    })

    return {
      makeAction<T>(namespace: string) {
        const send = async (data: T): Promise<void[]> => {
          const promises: Promise<void>[] = []
          for (const other of bus.rooms.values()) {
            if (other === room || other.left) continue
            const handlers = other.receivers.get(namespace) ?? []
            for (const h of handlers) {
              promises.push(Promise.resolve().then(() => h(data, room.peerId)))
            }
          }
          await Promise.all(promises)
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
      leave: async (): Promise<void> => {
        if (room.left) return
        room.left = true
        bus.rooms.delete(peerId)
        for (const other of bus.rooms.values()) {
          for (const fn of other.onLeave) fn(peerId)
        }
      },
    }
  }

  return { joinTopic, __resetBus: () => buses.clear() }
})

import {
  buildHello,
  buildPairAuthMessage,
  generatePairingCode,
  hostPairing,
  joinPairing,
  PAIR_WORD_COUNT,
  PairAbortedError,
  PairTimeoutError,
  PairVerificationError,
  verifyHello,
  type PairingContext,
} from '@/features/friends/pair'
import { pairPassword, pairTopic } from '@/lib/crypto/topics'
import { joinTopic } from '@/lib/trystero'

beforeEach(async () => {
  const mod = (await import('@/lib/trystero')) as unknown as {
    __resetBus: () => void
  }
  mod.__resetBus()
})

afterEach(() => {
  vi.useRealTimers()
})

function makeCtx(displayName: string): PairingContext & {
  edPriv: Uint8Array
} {
  const id = generateIdentity()
  return {
    edPubHex: bytesToHex(id.edPub),
    xPubHex: bytesToHex(id.xPub),
    displayName,
    edPriv: id.edPriv,
    sign: async (msg) => signMessage(id.edPriv, msg),
  }
}

describe('generatePairingCode', () => {
  test(`returns ${PAIR_WORD_COUNT} BIP39 words`, () => {
    const words = generatePairingCode()
    expect(words).toHaveLength(PAIR_WORD_COUNT)
    for (const w of words) {
      expect(w).toMatch(/^[a-z]+$/)
    }
  })

  test('two calls produce different codes', () => {
    const a = generatePairingCode().join(' ')
    const b = generatePairingCode().join(' ')
    expect(a).not.toEqual(b)
  })
})

describe('verifyHello', () => {
  test('accepts a hello signed over (words || ed_pubkey || x_pubkey)', async () => {
    const words = generatePairingCode()
    const ctx = makeCtx('Sam')
    const hello = await buildHello(words, ctx)
    const friend = verifyHello(words, hello)
    expect(friend.edPubkey).toBe(ctx.edPubHex)
    expect(friend.xPubkey).toBe(ctx.xPubHex)
    expect(friend.name).toBe('Sam')
  })

  test('rejects a hello with a tampered signature byte', async () => {
    const words = generatePairingCode()
    const ctx = makeCtx('Sam')
    const hello = await buildHello(words, ctx)
    const flipped =
      hello.sig.slice(0, -2) + (hello.sig.slice(-2) === '00' ? 'ff' : '00')
    expect(() => verifyHello(words, { ...hello, sig: flipped })).toThrow(
      PairVerificationError
    )
  })

  test('rejects a hello where the x_pubkey was substituted', async () => {
    const words = generatePairingCode()
    const ctx = makeCtx('Sam')
    const other = makeCtx('Mallory')
    const hello = await buildHello(words, ctx)
    expect(() =>
      verifyHello(words, { ...hello, x_pubkey: other.xPubHex })
    ).toThrow(PairVerificationError)
  })

  test('rejects a hello where the words context differs', async () => {
    const ctx = makeCtx('Sam')
    const helloWords = generatePairingCode()
    const verifyWords = generatePairingCode()
    const hello = await buildHello(helloWords, ctx)
    expect(() => verifyHello(verifyWords, hello)).toThrow(PairVerificationError)
  })
})

describe('buildPairAuthMessage', () => {
  test('host and joiner sides produce identical bytes for the same triple', () => {
    const words = generatePairingCode()
    const a = buildPairAuthMessage(words, '01ab', 'cd02')
    const b = buildPairAuthMessage([...words], '01ab', 'cd02')
    expect(bytesToHex(a)).toEqual(bytesToHex(b))
  })
})

describe('round-trip pairing (in-process two instances)', () => {
  test('host and joiner each receive the other identity', async () => {
    const words = generatePairingCode()
    const sam = makeCtx('Sam')
    const alice = makeCtx('Alice')

    const [samResult, aliceResult] = await Promise.all([
      hostPairing(words, sam),
      joinPairing(words, alice),
    ])

    expect(samResult).toEqual({
      edPubkey: alice.edPubHex,
      xPubkey: alice.xPubHex,
      name: 'Alice',
    })
    expect(aliceResult).toEqual({
      edPubkey: sam.edPubHex,
      xPubkey: sam.xPubHex,
      name: 'Sam',
    })
  })

  test('aborting via AbortSignal rejects with PairAbortedError', async () => {
    const words = generatePairingCode()
    const sam = makeCtx('Sam')
    const ctrl = new AbortController()
    const promise = hostPairing(words, sam, { signal: ctrl.signal })
    queueMicrotask(() => ctrl.abort())
    await expect(promise).rejects.toBeInstanceOf(PairAbortedError)
  })

  test('host rejects with PairTimeoutError when no peer arrives', async () => {
    vi.useFakeTimers()
    const words = generatePairingCode()
    const sam = makeCtx('Sam')
    const promise = hostPairing(words, sam, { timeoutMs: 1_000 })
    // Attach the rejection handler before advancing timers; otherwise the
    // setTimeout fires and rejects synchronously on the next tick, producing
    // a "PromiseRejectionHandledWarning" since the handler isn't yet on it.
    const assertion = expect(promise).rejects.toBeInstanceOf(PairTimeoutError)
    await vi.advanceTimersByTimeAsync(1_500)
    await assertion
  })

  test('F5: onPostArrivalStall fires when a peer arrives but no hello settles', async () => {
    vi.useFakeTimers()
    const words = generatePairingCode()
    const sam = makeCtx('Sam')
    const ctrl = new AbortController()
    let stalled = false
    let peerArrived = false

    // Host pairing with a short stall window and NO real timeout (the dialog
    // never deadlines). A bare room joins the same topic so the host sees a
    // peer arrive, but it never sends a hello → the channel-never-formed path.
    const promise = hostPairing(words, sam, {
      signal: ctrl.signal,
      stallMs: 45_000,
      onPeerJoinedTopic: () => {
        peerArrived = true
      },
      onPostArrivalStall: () => {
        stalled = true
      },
    })
    // Keep the rejection observed up front so aborting later doesn't warn.
    const settled = expect(promise).rejects.toBeInstanceOf(PairAbortedError)

    // A second (bare) participant on the topic triggers the host's onPeerJoin.
    const bare = joinTopic({
      topic: pairTopic(words),
      password: pairPassword(words),
    })

    // Let the join microtask flush so onPeerJoin (and the stall arming) runs.
    await vi.advanceTimersByTimeAsync(0)
    expect(peerArrived).toBe(true)
    expect(stalled).toBe(false)

    // Just before the window: still no stall.
    await vi.advanceTimersByTimeAsync(44_999)
    expect(stalled).toBe(false)

    // Crossing the window fires the one-shot stall hint.
    await vi.advanceTimersByTimeAsync(2)
    expect(stalled).toBe(true)

    // Abort to settle the still-open pairing promise; tear down the bare room.
    ctrl.abort()
    await bare.leave()
    await settled
  })

  test('onPeerJoinedTopic fires once on each side before the hello settles', async () => {
    const words = generatePairingCode()
    const sam = makeCtx('Sam')
    const alice = makeCtx('Alice')
    const samNotifications: number[] = []
    const aliceNotifications: number[] = []

    await Promise.all([
      hostPairing(words, sam, {
        onPeerJoinedTopic: () => samNotifications.push(Date.now()),
      }),
      joinPairing(words, alice, {
        onPeerJoinedTopic: () => aliceNotifications.push(Date.now()),
      }),
    ])

    expect(samNotifications).toHaveLength(1)
    expect(aliceNotifications).toHaveLength(1)
  })
})
