// I77 — one-way video: the local camera/mic must reach peers who join AFTER
// it was acquired, not just the ones already active.
//
// trystero's `addStream` fans out to `keys(activePeerMap)` at call time and
// queues nothing for later joiners (@trystero-p2p/core room.mjs:83, :494;
// activation at :306-314 fires only onPeerJoin). A host derives a random topic
// and opens its camera while provably alone, so a lone broadcast reached
// nobody and the guest never saw the host. These tests pin the re-send.

import { describe, expect, test } from 'vitest'

import { publishLocalStream } from '@/features/session/lifecycle'
import type { TopicRoom } from '@/lib/trystero'

type Listener = (peerId: string) => void

// A room that models the semantics that actually matter here: an untargeted
// addStream reaches only the currently-active peers; a targeted one reaches
// exactly its target; joining does NOT replay anything on its own.
function fakeRoom() {
  const joinSubs = new Set<Listener>()
  const active = new Set<string>()
  const delivered: { stream: unknown; peerId: string }[] = []

  const room = {
    selfId: 'self',
    makeAction: () => ({ send: async () => [], receive: () => {} }),
    onPeerJoin: (fn: Listener) => {
      joinSubs.add(fn)
      return () => joinSubs.delete(fn)
    },
    onPeerLeave: () => () => {},
    onPeerStream: () => () => {},
    addStream: (stream: MediaStream, targetPeers?: string | string[]) => {
      const targets =
        targetPeers == null
          ? [...active]
          : Array.isArray(targetPeers)
            ? targetPeers
            : [targetPeers]
      for (const peerId of targets) delivered.push({ stream, peerId })
    },
    removeStream: () => {},
    getPeers: () => ({}),
    leave: async () => {},
  } as unknown as TopicRoom

  return {
    room,
    delivered,
    join(peerId: string) {
      active.add(peerId)
      for (const fn of joinSubs) fn(peerId)
    },
  }
}

const STREAM = { id: 'local' } as unknown as MediaStream

describe('publishLocalStream (I77)', () => {
  test('reaches a peer who joins after the stream was acquired', () => {
    const bus = fakeRoom()
    // The host case: camera opens while the room is empty.
    publishLocalStream(bus.room, STREAM)
    expect(bus.delivered).toEqual([])

    bus.join('guest')

    expect(bus.delivered).toEqual([{ stream: STREAM, peerId: 'guest' }])
  })

  test('reaches a peer who was already active, exactly once', () => {
    const bus = fakeRoom()
    // The guest case: the host's peer is already active when our camera opens.
    bus.join('host')
    publishLocalStream(bus.room, STREAM)

    expect(bus.delivered).toEqual([{ stream: STREAM, peerId: 'host' }])
  })

  test('serves every peer exactly once across both paths', () => {
    const bus = fakeRoom()
    bus.join('early')
    publishLocalStream(bus.room, STREAM)
    bus.join('late')

    // A double-add would desync trystero's FIFO pairing of stream metadata to
    // incoming tracks, so "exactly once per peer" is the real invariant.
    expect(bus.delivered.map((d) => d.peerId)).toEqual(['early', 'late'])
  })

  test('unsubscribing stops the re-send so a stopped stream is never sent', () => {
    const bus = fakeRoom()
    const stop = publishLocalStream(bus.room, STREAM)

    stop()
    bus.join('guest')

    expect(bus.delivered).toEqual([])
  })
})
