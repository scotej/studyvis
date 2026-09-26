import { afterEach, describe, expect, test, vi } from 'vitest'

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

const MEDIA_OFFER = {
  type: 'offer',
  sdp: 'v=0\r\na=rtpmap:96 VP8/90000\r\n',
}

class NativeChannel {
  readyState = 'open'
  onclose: (() => void) | null = null
  closeCalls = 0
  readonly events: string[]

  constructor(events: string[]) {
    this.events = events
  }

  close() {
    this.closeCalls += 1
    this.readyState = 'closed'
    this.events.push('channel.close')
    this.onclose?.()
  }
}

// Exercise the installed PeerHandle and SharedPeerManager together: native
// SDP rejection reaches the shared peer's error handler while ICE is healthy.
class NativeConnection extends EventTarget {
  connectionState = 'connected'
  iceConnectionState = 'connected'
  signalingState = 'stable'
  localDescription: RTCSessionDescriptionInit | null = null
  remoteDescription: RTCSessionDescriptionInit | null = null
  ondatachannel: ((event: { channel: NativeChannel }) => void) | null = null
  remoteDescriptionResult: Promise<void> = Promise.resolve()
  closeCalls = 0
  events: string[] = []

  async setRemoteDescription(description: RTCSessionDescriptionInit) {
    await this.remoteDescriptionResult
    this.remoteDescription = description
  }

  async setLocalDescription() {
    this.localDescription = { type: 'answer', sdp: MEDIA_OFFER.sdp }
  }

  close() {
    this.closeCalls += 1
    this.connectionState = 'closed'
    this.iceConnectionState = 'closed'
    this.events.push('connection.close')
  }
}

function endpoint(manager = new SharedPeerManager(), peerId = 'friend') {
  const peer = createPeer(false, { rtcPolyfill: NativeConnection })
  const connection = peer.connection as NativeConnection
  const channel = new NativeChannel(connection.events)
  connection.ondatachannel?.({ channel })
  const shared = manager.register('studyvis', peerId, peer, 1_000)
  return { peer, connection, channel, shared, manager }
}

afterEach(() => vi.restoreAllMocks())

describe('Trystero terminal peer error cleanup', () => {
  test('closes the channel and connected transport before reporting a failed media negotiation', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { peer, connection, channel, shared, manager } = endpoint()
    const { proxy } = manager.bind(
      'session',
      Promise.resolve('session-token'),
      shared,
      { onDetach() {} }
    )
    proxy.setHandlers({
      close: () => connection.events.push('session.close'),
    })
    connection.remoteDescriptionResult = Promise.reject(
      new Error('failed media renegotiation')
    )

    await peer.signal(MEDIA_OFFER)

    expect(manager.get('studyvis', 'friend')).toBeUndefined()
    expect(channel.readyState).toBe('closed')
    expect(connection.connectionState).toBe('closed')
    expect(channel.closeCalls).toBe(1)
    expect(connection.closeCalls).toBe(1)
    expect(connection.events).toEqual([
      'channel.close',
      'connection.close',
      'session.close',
    ])
  })

  test('a delayed negotiation rejection cannot remove a replacement peer', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const previous = endpoint()
    endpoint(previous.manager, 'another-friend')
    let rejectDescription!: (error: Error) => void
    previous.connection.remoteDescriptionResult = new Promise((_, reject) => {
      rejectDescription = reject
    })
    const pendingSignal = previous.peer.signal(MEDIA_OFFER)
    const replacement = endpoint(previous.manager)
    expect(previous.manager.get('studyvis', 'friend')).toBe(replacement.shared)

    rejectDescription(new Error('old negotiation completed after replacement'))
    await pendingSignal

    expect(previous.manager.get('studyvis', 'friend')).toBe(replacement.shared)
    expect(replacement.connection.connectionState).toBe('connected')
    expect(replacement.channel.readyState).toBe('open')
    expect(previous.connection.closeCalls).toBe(1)
    replacement.manager.clear('studyvis', 'friend', { destroyPeer: true })
    replacement.manager.clear('studyvis', 'another-friend', {
      destroyPeer: true,
    })
  })

  test('leaving a session keeps the healthy transport used by presence', async () => {
    const { connection, channel, shared, manager } = endpoint()
    const { proxy } = manager.bind(
      'session',
      Promise.resolve('session-token'),
      shared,
      { onDetach() {} }
    )
    manager.bind('presence', Promise.resolve('presence-token'), shared, {
      onDetach() {},
    })
    await Promise.resolve()

    proxy.destroy()

    expect(manager.get('studyvis', 'friend')).toBe(shared)
    expect(Object.keys(shared.bindings)).toEqual(['presence'])
    expect(connection.connectionState).toBe('connected')
    expect(channel.readyState).toBe('open')
    manager.clear('studyvis', 'friend', { destroyPeer: true })
  })

  test('retains the replacement when replacing the only peer for an app', () => {
    const previous = endpoint()
    const roomPeerMap = previous.manager.getMap('studyvis')

    const replacement = endpoint(previous.manager)

    expect(previous.manager.get('studyvis', 'friend')).toBe(replacement.shared)
    expect(roomPeerMap.friend).toBe(replacement.shared)
    expect(previous.connection.connectionState).toBe('closed')
    expect(replacement.connection.connectionState).toBe('connected')
    replacement.manager.clear('studyvis', 'friend', { destroyPeer: true })
  })

  test('existing rooms see a new peer after the last transport was cleared', () => {
    const previous = endpoint()
    const roomPeerMap = previous.manager.getMap('studyvis')

    previous.manager.clear('studyvis', 'friend', { destroyPeer: true })
    expect(Object.keys(roomPeerMap)).toEqual([])
    const replacement = endpoint(previous.manager)

    expect(previous.manager.getMap('studyvis')).toBe(roomPeerMap)
    expect(roomPeerMap.friend).toBe(replacement.shared)
    replacement.manager.clear('studyvis', 'friend', { destroyPeer: true })
  })
})
