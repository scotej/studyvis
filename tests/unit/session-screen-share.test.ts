// #96 / #223 — screen sharing rides the session room alongside the camera, so
// the controller has two invariants worth pinning:
//
//   1. A screen stream reaches each peer transport incarnation EXACTLY once. A
//      repeat `addStream` of the same stream object is a no-op inside trystero's
//      shared peer (shared-peer.mjs:206-211) but room.mjs still emits the
//      stream-meta packet, and the receiver pairs metas to incoming streams FIFO
//      (room.mjs:438-443). One orphan meta mislabels every later stream on that
//      connection — invisible before this feature, because there was only ever
//      one stream.
//   2. A peer that has never spoken this protocol is never handed one. An older
//      build binds any incoming stream to the friend's face tile and has no way
//      to clear it (trystero has no stream-removed event).

import { describe, expect, test } from 'vitest'

import {
  startScreenShareController,
  type ScreenSharePayload,
} from '@/features/session/screenShare'
import type { TopicRoom } from '@/lib/trystero'

type Listener = (peerId: string) => void

function fakeRoom() {
  const joinSubs = new Set<Listener>()
  const leaveSubs = new Set<Listener>()
  const active = new Set<string>()
  const added: { stream: MediaStream; peerId: string; metadata: unknown }[] = []
  const removed: MediaStream[] = []
  const sent: { data: ScreenSharePayload; target: string | undefined }[] = []
  let receiver: ((data: ScreenSharePayload, peerId: string) => void) | null =
    null

  const room = {
    selfId: 'self',
    makeAction: () => ({
      send: async (data: ScreenSharePayload, target?: string) => {
        sent.push({ data, target })
        return []
      },
      receive: (fn: (data: ScreenSharePayload, peerId: string) => void) => {
        receiver = fn
      },
    }),
    onPeerJoin: (fn: Listener) => {
      joinSubs.add(fn)
      return () => joinSubs.delete(fn)
    },
    onPeerLeave: (fn: Listener) => {
      leaveSubs.add(fn)
      return () => leaveSubs.delete(fn)
    },
    onPeerStream: () => () => {},
    addStream: (
      stream: MediaStream,
      targetPeers?: string | string[],
      metadata?: unknown
    ) => {
      const targets =
        targetPeers == null
          ? [...active]
          : Array.isArray(targetPeers)
            ? targetPeers
            : [targetPeers]
      for (const peerId of targets) added.push({ stream, peerId, metadata })
    },
    removeStream: (stream: MediaStream) => {
      removed.push(stream)
    },
    getPeers: () =>
      Object.fromEntries(
        [...active].map((id) => [id, {} as RTCPeerConnection])
      ),
    leave: async () => {},
  } as unknown as TopicRoom

  return {
    room,
    added,
    removed,
    sent,
    join(peerId: string) {
      active.add(peerId)
      for (const fn of joinSubs) fn(peerId)
    },
    // Trystero replaces an active same-id peer by emitting another join without
    // first emitting a leave for the old transport.
    replace(peerId: string) {
      active.add(peerId)
      for (const fn of joinSubs) fn(peerId)
    },
    leave(peerId: string) {
      active.delete(peerId)
      for (const fn of leaveSubs) fn(peerId)
    },
    // A peer telling us what they're doing — which is also what proves they
    // speak this protocol at all.
    announce(peerId: string, payload: ScreenSharePayload) {
      receiver?.(payload, peerId)
    },
  }
}

const SILENT: ScreenSharePayload = { sharing: false, stream_id: null }

function stream(id: string): MediaStream {
  return { id } as unknown as MediaStream
}

function start(bus: ReturnType<typeof fakeRoom>) {
  const changes: { peerId: string; sharing: boolean }[] = []
  const controller = startScreenShareController({
    room: bus.room,
    onPeerSharingChange: (peerId, sharing) => changes.push({ peerId, sharing }),
  })
  return { controller, changes }
}

describe('screen-share capability gate', () => {
  test('never publishes to a peer that has not announced', () => {
    const bus = fakeRoom()
    const { controller } = start(bus)
    bus.join('older-build')

    controller.publish(stream('screen-1'))

    expect(bus.added).toEqual([])
  })

  test('announces to a joining peer without publishing', () => {
    const bus = fakeRoom()
    const { controller } = start(bus)
    controller.publish(stream('screen-1'))
    bus.join('friend')

    expect(bus.added).toEqual([])
    expect(bus.sent.at(-1)).toEqual({
      data: { sharing: true, stream_id: 'screen-1' },
      target: 'friend',
    })
  })

  test('publishes once the peer announces back', () => {
    const bus = fakeRoom()
    const { controller } = start(bus)
    const screen = stream('screen-1')
    controller.publish(screen)
    bus.join('friend')
    bus.announce('friend', SILENT)

    expect(bus.added).toEqual([
      {
        stream: screen,
        peerId: 'friend',
        metadata: { kind: 'screen', stream_id: 'screen-1' },
      },
    ])
  })

  test('publishes to peers that announced before we started sharing', () => {
    const bus = fakeRoom()
    const { controller } = start(bus)
    bus.join('friend')
    bus.announce('friend', SILENT)

    const screen = stream('screen-1')
    controller.publish(screen)

    expect(bus.added).toEqual([
      {
        stream: screen,
        peerId: 'friend',
        metadata: { kind: 'screen', stream_id: 'screen-1' },
      },
    ])
  })

  test('requires a same-id replacement to announce capability again', () => {
    const bus = fakeRoom()
    const { controller } = start(bus)
    bus.join('friend')
    bus.announce('friend', SILENT)
    const first = stream('screen-1')
    const second = stream('screen-2')
    controller.publish(first)

    bus.replace('friend')
    controller.publish(second)

    // The replacement could be an older build. Until it announces on the
    // current connection, it must not inherit the old connection's capability.
    expect(bus.added.map((a) => a.stream)).toEqual([first])

    bus.announce('friend', SILENT)

    expect(bus.added.map((a) => a.stream)).toEqual([first, second])
  })
})

describe('screen-share exactly-once publishing', () => {
  test('a repeated announce does not re-add the stream', () => {
    const bus = fakeRoom()
    const { controller } = start(bus)
    bus.join('friend')
    bus.announce('friend', SILENT)
    controller.publish(stream('screen-1'))

    bus.announce('friend', { sharing: true, stream_id: 'their-screen' })
    bus.announce('friend', SILENT)

    expect(bus.added).toHaveLength(1)
  })

  test('serves every peer exactly once across both entry paths', () => {
    const bus = fakeRoom()
    const { controller } = start(bus)
    bus.join('early')
    bus.announce('early', SILENT)

    controller.publish(stream('screen-1'))

    bus.join('late')
    bus.announce('late', SILENT)

    expect(bus.added.map((a) => a.peerId)).toEqual(['early', 'late'])
  })

  test('a peer that blips and returns is published to again', () => {
    const bus = fakeRoom()
    const { controller } = start(bus)
    bus.join('friend')
    bus.announce('friend', SILENT)
    const screen = stream('screen-1')
    controller.publish(screen)

    // Same peerId, brand-new RTCPeerConnection: the stream has to be added
    // again or their tile stays blank for good.
    bus.leave('friend')
    bus.join('friend')
    bus.announce('friend', SILENT)

    expect(bus.added.map((a) => a.peerId)).toEqual(['friend', 'friend'])
  })

  test('a same-id replacement is published to again without a leave', () => {
    const bus = fakeRoom()
    const { controller } = start(bus)
    bus.join('friend')
    bus.announce('friend', SILENT)
    const screen = stream('screen-1')
    controller.publish(screen)

    // Trystero's replacement path emits only the second join. The replacement
    // must receive the already-active share after it announces on its new data
    // channel, but repeated announces must not emit a third metadata packet.
    bus.replace('friend')
    bus.announce('friend', SILENT)
    bus.announce('friend', SILENT)

    expect(bus.added.map((a) => a.peerId)).toEqual(['friend', 'friend'])
    expect(bus.added.map((a) => a.stream)).toEqual([screen, screen])
  })

  test('re-sharing retires the old stream and publishes the new one', () => {
    const bus = fakeRoom()
    const { controller } = start(bus)
    bus.join('friend')
    bus.announce('friend', SILENT)
    const first = stream('screen-1')
    const second = stream('screen-2')

    controller.publish(first)
    controller.publish(second)

    expect(bus.removed).toEqual([first])
    expect(bus.added.map((a) => a.stream)).toEqual([first, second])
  })
})

describe('screen-share stop', () => {
  test('unpublish removes the stream and broadcasts the stop', () => {
    const bus = fakeRoom()
    const { controller } = start(bus)
    bus.join('friend')
    bus.announce('friend', SILENT)
    const screen = stream('screen-1')
    controller.publish(screen)

    controller.unpublish()

    expect(bus.removed).toEqual([screen])
    expect(bus.sent.at(-1)).toEqual({ data: SILENT, target: undefined })
  })

  test('teardown pulls a still-published stream and stops publishing', () => {
    const bus = fakeRoom()
    const { controller } = start(bus)
    bus.join('friend')
    bus.announce('friend', SILENT)
    const screen = stream('screen-1')
    controller.publish(screen)

    controller.teardown()
    bus.join('second')
    bus.announce('second', SILENT)

    expect(bus.removed).toEqual([screen])
    expect(bus.added.map((a) => a.peerId)).toEqual(['friend'])
  })

  test("a peer's stop is reported, and so is their departure", () => {
    const bus = fakeRoom()
    const { changes } = start(bus)
    bus.join('friend')
    bus.announce('friend', { sharing: true, stream_id: 'their-screen' })
    bus.announce('friend', SILENT)
    bus.announce('friend', { sharing: true, stream_id: 'their-screen-2' })
    bus.leave('friend')

    expect(changes).toEqual([
      { peerId: 'friend', sharing: true },
      { peerId: 'friend', sharing: false },
      { peerId: 'friend', sharing: true },
      { peerId: 'friend', sharing: false },
    ])
  })

  test("a same-id replacement retires the old peer's screen state", () => {
    const bus = fakeRoom()
    const { changes } = start(bus)
    bus.join('friend')
    bus.announce('friend', { sharing: true, stream_id: 'their-screen' })

    bus.replace('friend')
    bus.announce('friend', {
      sharing: true,
      stream_id: 'their-rejoined-screen',
    })

    expect(changes).toEqual([
      { peerId: 'friend', sharing: true },
      { peerId: 'friend', sharing: false },
      { peerId: 'friend', sharing: true },
    ])
  })

  test('a malformed payload is ignored rather than trusted', () => {
    const bus = fakeRoom()
    const { controller, changes } = start(bus)
    bus.join('friend')
    bus.announce('friend', { sharing: 'yes' } as unknown as ScreenSharePayload)
    controller.publish(stream('screen-1'))

    expect(changes).toEqual([])
    // Never announced validly, so it never counted as capable.
    expect(bus.added).toEqual([])
  })
})

describe('screen-share stream classification', () => {
  test('the announced stream id identifies the screen', () => {
    const bus = fakeRoom()
    const { controller } = start(bus)
    bus.join('friend')
    bus.announce('friend', { sharing: true, stream_id: 'their-screen' })

    expect(controller.classify('friend', stream('their-screen'))).toBe('screen')
    expect(controller.classify('friend', stream('their-camera'))).toBe('camera')
  })

  test('metadata classifies a stream that outran its announce', () => {
    const bus = fakeRoom()
    const { controller } = start(bus)
    bus.join('friend')

    expect(
      controller.classify('friend', stream('their-screen'), { kind: 'screen' })
    ).toBe('screen')
    expect(controller.classify('friend', stream('their-camera'))).toBe('camera')
  })

  test('id-bound metadata rejects a FIFO tag that landed on the camera', () => {
    const bus = fakeRoom()
    const { controller } = start(bus)
    bus.join('friend')

    expect(
      controller.classify('friend', stream('their-camera'), {
        kind: 'screen',
        stream_id: 'their-screen',
      })
    ).toBe('camera')
    expect(
      controller.classify('friend', stream('their-screen'), {
        kind: 'screen',
        stream_id: 'their-screen',
      })
    ).toBe('screen')
  })

  test('the announced id overrides mismatched metadata after a reconnect', () => {
    const bus = fakeRoom()
    const { controller } = start(bus)
    bus.join('friend')
    bus.announce('friend', { sharing: true, stream_id: 'their-screen' })

    // Camera and screen are both re-published onto the new RTCPeerConnection.
    // Trystero pairs metadata to arriving streams FIFO, so renegotiation can
    // hand the screen tag to the camera and no tag to the actual screen.
    expect(
      controller.classify('friend', stream('their-camera'), {
        kind: 'screen',
        stream_id: 'their-screen',
      })
    ).toBe('camera')
    expect(controller.classify('friend', stream('their-screen'))).toBe('screen')
  })

  test('a stopped share retires its stream and rejects stale metadata', () => {
    const bus = fakeRoom()
    const { controller } = start(bus)
    bus.join('friend')
    bus.announce('friend', { sharing: true, stream_id: 'their-screen' })
    bus.announce('friend', SILENT)

    expect(
      controller.classify('friend', stream('their-screen'), {
        kind: 'screen',
        stream_id: 'their-screen',
      })
    ).toBe('ignore')
    expect(
      controller.classify('friend', stream('their-camera'), {
        kind: 'screen',
        stream_id: 'their-screen',
      })
    ).toBe('camera')
    expect(
      controller.classify('friend', stream('their-camera'), { kind: 'screen' })
    ).toBe('camera')
  })

  test('id-bound metadata can start a new share before its next announce', () => {
    const bus = fakeRoom()
    const { controller } = start(bus)
    bus.join('friend')
    bus.announce('friend', { sharing: true, stream_id: 'their-old-screen' })
    bus.announce('friend', SILENT)

    expect(
      controller.classify('friend', stream('their-new-screen'), {
        kind: 'screen',
        stream_id: 'their-new-screen',
      })
    ).toBe('screen')
  })

  test('a peer rejoin clears retired screen ids', () => {
    const bus = fakeRoom()
    const { controller } = start(bus)
    bus.join('friend')
    bus.announce('friend', { sharing: true, stream_id: 'their-screen' })
    bus.announce('friend', SILENT)
    bus.leave('friend')
    bus.join('friend')

    expect(
      controller.classify('friend', stream('their-screen'), {
        kind: 'screen',
        stream_id: 'their-screen',
      })
    ).toBe('screen')
  })

  test('one peer id never classifies another peer stream', () => {
    const bus = fakeRoom()
    const { controller } = start(bus)
    bus.join('a')
    bus.join('b')
    bus.announce('a', { sharing: true, stream_id: 'a-screen' })

    expect(controller.classify('b', stream('a-screen'))).toBe('camera')
  })
})
