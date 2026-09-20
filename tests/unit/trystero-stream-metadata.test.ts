import { describe, expect, test } from 'vitest'

const { default: createPeer } = await import(
  new URL(
    '../../node_modules/@trystero-p2p/core/dist/peer.mjs',
    import.meta.url
  ).href
)
const { SharedPeerManager } = await import(
  new URL(
    '../../node_modules/@trystero-p2p/core/dist/shared-peer.mjs',
    import.meta.url
  ).href
)
const { createMediaManager } = await import(
  new URL(
    '../../node_modules/@trystero-p2p/core/dist/media.mjs',
    import.meta.url
  ).href
)

type StreamAnnouncement = { k: string; s?: string; m?: unknown }
type ReceivedStream = { streamId: string; metadata?: unknown }

// Only the native boundary is fake. Real PeerHandle and SharedPeerManager
// dispatch every audio/video track through the real room media manager; a
// fake room that emits once per stream would conceal this regression.
class NativeConnection extends EventTarget {
  connectionState = 'connected'
  iceConnectionState = 'connected'
  signalingState = 'stable'
  tracks: Array<{ track: MediaStreamTrack; stream: MediaStream }> = []
  ontrack: ((event: Pick<RTCTrackEvent, 'track' | 'streams'>) => void) | null =
    null

  addTrack(track: MediaStreamTrack, stream: MediaStream) {
    this.tracks.push({ track, stream })
    return { track }
  }

  close() {
    this.connectionState = 'closed'
  }
}

function stream(id: string, kinds: string[]): MediaStream {
  const tracks = kinds.map(
    (kind) =>
      ({ id: `${id}-${kind}`, kind, readyState: 'live' }) as MediaStreamTrack
  )
  return { id, getTracks: () => tracks } as MediaStream
}

function endpoint(roomId: string) {
  const peer = createPeer(false, { rtcPolyfill: NativeConnection })
  const manager = new SharedPeerManager()
  const shared = manager.register('studyvis', 'friend', peer, 1_000)
  const { proxy } = manager.bind(
    roomId,
    Promise.resolve(`${roomId}-token`),
    shared,
    { onDetach() {} }
  )
  const media = createMediaManager({
    iterate: (
      _targets: unknown,
      fn: (id: string, value: unknown) => unknown
    ) => [fn('friend', proxy)],
    isActive: () => true,
    getSharedMediaPeer: () => proxy,
  })
  const received: ReceivedStream[] = []
  media.onPeerStream = (
    value: MediaStream,
    _peerId: string,
    metadata?: unknown
  ) => received.push({ streamId: value.id, metadata })
  // Matches room.mjs's production handlers, after the shared peer's fan-out.
  proxy.setHandlers({
    stream: (value: MediaStream) => media.receiveRemoteStream('friend', value),
    track: (track: MediaStreamTrack, value: MediaStream) =>
      media.receiveRemoteTrack('friend', track, value),
  })
  return {
    media,
    received,
    connection: peer.connection as NativeConnection,
    close: () => manager.clear('studyvis', 'friend', { destroyPeer: true }),
  }
}

function harness({ withoutStreamId = false, delayMetadata = false } = {}) {
  const sender = endpoint('sender-room')
  const receiver = endpoint('receiver-room')
  const camera = stream('camera', ['audio', 'video'])
  const screen = stream('screen', ['video'])
  const announcements: StreamAnnouncement[] = []
  const sendMetadata = async (announcement: StreamAnnouncement) => {
    const wire: StreamAnnouncement = { ...announcement }
    if (withoutStreamId) delete wire.s
    announcements.push(wire)
    if (!delayMetadata) receiver.media.receiveStreamMeta(wire, 'friend')
  }
  return {
    received: receiver.received,
    announcements,
    publishBoth: () =>
      Promise.all([
        ...sender.media.addStream(camera, {}, sendMetadata),
        ...sender.media.addStream(
          screen,
          { metadata: { kind: 'screen', stream_id: 'screen' } },
          sendMetadata
        ),
      ]),
    deliverTrack: (trackId: string) => {
      const event = sender.connection.tracks.find(
        ({ track }) => track.id === trackId
      )
      if (!event) throw new Error(`No published track: ${trackId}`)
      receiver.connection.ontrack?.({
        track: event.track,
        streams: [event.stream],
      })
    },
    announce: (announcement: StreamAnnouncement) =>
      receiver.media.receiveStreamMeta(announcement, 'friend'),
    close: () => {
      sender.close()
      receiver.close()
    },
  }
}

describe('patched Trystero stream metadata', () => {
  test('camera audio and video do not consume the screen announcement', async () => {
    const bus = harness()
    try {
      await bus.publishBoth()
      bus.deliverTrack('camera-audio')
      bus.deliverTrack('camera-video')
      bus.deliverTrack('screen-video')

      expect(bus.received).toEqual([
        { streamId: 'camera', metadata: undefined },
        {
          streamId: 'screen',
          metadata: { kind: 'screen', stream_id: 'screen' },
        },
      ])
    } finally {
      bus.close()
    }
  })

  test.each([
    ['screen first', ['screen-video', 'camera-video', 'camera-audio']],
    ['interleaved', ['camera-audio', 'screen-video', 'camera-video']],
    ['camera video first', ['camera-video', 'camera-audio', 'screen-video']],
  ])(
    'matches stream identity when native tracks arrive %s',
    async (_name, order) => {
      const bus = harness()
      try {
        await bus.publishBoth()
        for (const track of order) bus.deliverTrack(track)

        expect(
          bus.received.filter((event) => event.streamId === 'camera')
        ).toEqual([{ streamId: 'camera', metadata: undefined }])
        expect(
          bus.received.filter((event) => event.streamId === 'screen')
        ).toEqual([
          {
            streamId: 'screen',
            metadata: { kind: 'screen', stream_id: 'screen' },
          },
        ])
      } finally {
        bus.close()
      }
    }
  )

  test('screen metadata replay retrieves the screen from the shared cache', async () => {
    const bus = harness()
    try {
      await bus.publishBoth()
      bus.deliverTrack('camera-audio')
      bus.deliverTrack('camera-video')
      bus.deliverTrack('screen-video')
      bus.received.length = 0

      bus.announce(bus.announcements[1]!)

      expect(bus.received).toEqual([
        {
          streamId: 'screen',
          metadata: { kind: 'screen', stream_id: 'screen' },
        },
      ])
    } finally {
      bus.close()
    }
  })

  test('a native stream cannot steal metadata naming a different stream', async () => {
    const bus = harness({ delayMetadata: true })
    try {
      await bus.publishBoth()
      bus.announce(bus.announcements[1]!)

      bus.deliverTrack('camera-audio')
      bus.deliverTrack('camera-video')
      expect(bus.received).toEqual([])

      bus.deliverTrack('screen-video')
      expect(bus.received).toEqual([
        {
          streamId: 'screen',
          metadata: { kind: 'screen', stream_id: 'screen' },
        },
      ])
    } finally {
      bus.close()
    }
  })

  test('delayed metadata finds the native stream without another track event', async () => {
    const bus = harness({ delayMetadata: true })
    try {
      await bus.publishBoth()
      bus.deliverTrack('camera-audio')
      bus.deliverTrack('camera-video')
      bus.deliverTrack('screen-video')
      expect(bus.received).toEqual([])

      bus.announce(bus.announcements[1]!)
      bus.announce(bus.announcements[0]!)

      expect(bus.received).toEqual([
        {
          streamId: 'screen',
          metadata: { kind: 'screen', stream_id: 'screen' },
        },
        { streamId: 'camera', metadata: undefined },
      ])
    } finally {
      bus.close()
    }
  })

  test('retains the FIFO fallback for synthetic ID-less metadata', async () => {
    const bus = harness({ withoutStreamId: true })
    try {
      await bus.publishBoth()
      bus.deliverTrack('camera-audio')
      bus.deliverTrack('screen-video')
      bus.deliverTrack('camera-video')

      expect(bus.received).toEqual([
        { streamId: 'camera', metadata: undefined },
        {
          streamId: 'screen',
          metadata: { kind: 'screen', stream_id: 'screen' },
        },
      ])
    } finally {
      bus.close()
    }
  })

  test('an exact stream ID takes precedence over an earlier ID-less announcement', async () => {
    const bus = harness({ delayMetadata: true })
    try {
      await bus.publishBoth()
      const idlessCamera = { ...bus.announcements[0]! }
      delete idlessCamera.s
      bus.announce(idlessCamera)
      bus.announce(bus.announcements[1]!)

      bus.deliverTrack('screen-video')
      bus.deliverTrack('camera-audio')
      bus.deliverTrack('camera-video')

      expect(bus.received).toEqual([
        {
          streamId: 'screen',
          metadata: { kind: 'screen', stream_id: 'screen' },
        },
        { streamId: 'camera', metadata: undefined },
      ])
    } finally {
      bus.close()
    }
  })
})
