import { describe, expect, test, vi } from 'vitest'

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

const sdp = (ufrag: string, password = `${ufrag}-password`) =>
  `v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=mid:0\r\na=ice-ufrag:${ufrag}\r\na=ice-pwd:${password}\r\n`

class NativeConnection extends EventTarget {
  connectionState = 'connected'
  iceConnectionState = 'connected'
  signalingState = 'stable'
  remoteDescription = { type: 'offer', sdp: sdp('old') }
  localDescription = { type: 'answer', sdp: sdp('local') }
  ondatachannel: ((event: { channel: object }) => void) | null = null
  readonly setRemoteDescription = vi.fn(
    async (description: RTCSessionDescriptionInit) => {
      this.remoteDescription = description as typeof this.remoteDescription
    }
  )
  readonly setLocalDescription = vi.fn(async () => {})
  close() {
    this.connectionState = 'closed'
  }
}

function endpoint() {
  const peer = createPeer(false, { rtcPolyfill: NativeConnection })
  const connection = peer.connection as NativeConnection
  connection.ondatachannel?.({ channel: { readyState: 'open', close() {} } })
  peer.setHandlers({
    error: (error: Error) => {
      throw error
    },
  })
  return { peer, connection }
}

describe('#499 authenticated data-only ICE restart signaling', () => {
  test('still rejects stale discovery SDP even with different ICE credentials', async () => {
    const h = endpoint()
    try {
      await h.peer.signal({ type: 'offer', sdp: sdp('new') })
      expect(h.connection.setRemoteDescription).not.toHaveBeenCalled()
    } finally {
      h.peer.destroy()
    }
  })

  test.each(['offer', 'answer'])(
    'accepts an authenticated restart %s through a shared room proxy',
    async (type) => {
      const h = endpoint()
      const manager = new SharedPeerManager()
      const shared = manager.register('studyvis', 'friend', h.peer, 1_000)
      const { proxy } = manager.bind(
        'inbox',
        Promise.resolve('token'),
        shared,
        { onDetach() {} }
      )
      try {
        await proxy.signal({ type, sdp: sdp('new') }, true)
        expect(
          h.connection.setRemoteDescription
        ).toHaveBeenCalledExactlyOnceWith({ type, sdp: sdp('new') })
      } finally {
        manager.clear('studyvis', 'friend', { destroyPeer: true })
      }
    }
  )

  test.each([sdp('old'), 'v=0\r\na=ice-ufrag:new\r\n'])(
    'rejects duplicate or incomplete data-only control SDP',
    async (description) => {
      const h = endpoint()
      try {
        await h.peer.signal({ type: 'offer', sdp: description }, true)
        expect(h.connection.setRemoteDescription).not.toHaveBeenCalled()
      } finally {
        h.peer.destroy()
      }
    }
  )
})
