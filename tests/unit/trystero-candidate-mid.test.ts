import { describe, expect, test, vi } from 'vitest'

const { default: createPeer } = await import(
  new URL(
    '../../node_modules/@trystero-p2p/core/dist/peer.mjs',
    import.meta.url
  ).href
)

const INITIAL_SDP =
  'v=0\r\n' +
  'm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n' +
  'a=mid:0\r\na=ice-ufrag:fixture\r\n' +
  'm=video 9 UDP/TLS/RTP/SAVPF 96\r\n' +
  'a=mid:1\r\na=ice-ufrag:fixture\r\n'
const FUTURE_SDP =
  INITIAL_SDP +
  'm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n' +
  'a=mid:2\r\na=ice-ufrag:fixture\r\n'
const HOST_CANDIDATE = {
  candidate: 'candidate:fixture 1 udp 1 127.0.0.1 9 typ host',
  usernameFragment: null,
}
const NATIVE_ERROR = new DOMException(
  'synthetic native candidate failure',
  'OperationError'
)

// Inject only the native boundary. The installed peer owns candidate eligibility,
// queue retention, description changes and error delivery.
class NativeConnection extends EventTarget {
  static latest: NativeConnection
  connectionState = 'new'
  iceConnectionState = 'new'
  signalingState = 'stable'
  remoteDescription: RTCSessionDescriptionInit | null = null
  localDescription: RTCSessionDescriptionInit | null = null
  rejectNextCandidate = false
  readonly addIceCandidate = vi.fn(async (candidate: RTCIceCandidateInit) => {
    if (this.rejectNextCandidate) {
      this.rejectNextCandidate = false
      throw NATIVE_ERROR
    }
    if (
      typeof candidate.sdpMid === 'string' &&
      !this.remoteDescription?.sdp
        ?.split('\r\n')
        .includes(`a=mid:${candidate.sdpMid}`)
    ) {
      throw new DOMException('native unknown remote MID', 'OperationError')
    }
  })

  constructor() {
    super()
    NativeConnection.latest = this
  }
  async setRemoteDescription(description: RTCSessionDescriptionInit) {
    this.remoteDescription = description
    this.signalingState = 'have-remote-offer'
  }
  async setLocalDescription(description?: RTCSessionDescriptionInit) {
    this.localDescription = description ?? {
      type: 'answer',
      sdp: this.remoteDescription!.sdp,
    }
    this.signalingState = 'stable'
  }
  close() {
    this.connectionState = 'closed'
  }
}

function harness() {
  const peer = createPeer(false, { rtcPolyfill: NativeConnection })
  const native = NativeConnection.latest
  const error = vi.fn()
  peer.setHandlers({ error, signal: vi.fn() })
  return {
    peer,
    native,
    error,
    offer: (sdp: string) => peer.signal({ type: 'offer', sdp }),
    candidate: (candidate: Partial<RTCIceCandidateInit>) =>
      peer.signal({
        type: 'candidate',
        sdp: JSON.stringify({ ...HOST_CANDIDATE, ...candidate }),
      }),
  }
}

describe('#349 remote ICE candidate MID eligibility', () => {
  test('queues unmatched provisional MIDs despite fitting indices and null ufrags', async () => {
    const h = harness()
    try {
      await h.offer(INITIAL_SDP)
      await h.candidate({ sdpMid: 'video0', sdpMLineIndex: 1 })
      await h.candidate({ sdpMid: 'audio1', sdpMLineIndex: 0 })
      // Exact matching matters: MID "1" must not make MID "video1" eligible.
      await h.candidate({ sdpMid: 'video1', sdpMLineIndex: 1 })
      expect(h.native.addIceCandidate).not.toHaveBeenCalled()
      expect(h.error).not.toHaveBeenCalled()

      await h.candidate({ sdpMid: '1', sdpMLineIndex: 1 })
      await h.candidate({ sdpMid: null, sdpMLineIndex: 0 })
      await h.candidate({ sdpMLineIndex: 1 })
      expect(
        h.native.addIceCandidate.mock.calls.map(([c]) => c.sdpMid)
      ).toEqual(['1', null, undefined])
      expect(h.error).not.toHaveBeenCalled()
    } finally {
      h.peer.destroy()
    }
  })

  test('retains a future MID until matching SDP and flushes it exactly once', async () => {
    const h = harness()
    try {
      // Candidates can arrive before their remote description.
      await h.candidate({ sdpMid: 'video0', sdpMLineIndex: 1 })
      await h.candidate({ sdpMid: '2', sdpMLineIndex: 2 })
      await h.offer(INITIAL_SDP)
      expect(h.native.addIceCandidate).not.toHaveBeenCalled()
      await h.offer(FUTURE_SDP)
      expect(h.native.addIceCandidate).toHaveBeenCalledExactlyOnceWith({
        ...HOST_CANDIDATE,
        sdpMid: '2',
        sdpMLineIndex: 2,
      })
      await h.offer(FUTURE_SDP)
      expect(h.native.addIceCandidate).toHaveBeenCalledTimes(1)
      expect(h.error).not.toHaveBeenCalled()
    } finally {
      h.peer.destroy()
    }
  })

  test('still reports native failures for an eligible candidate', async () => {
    const h = harness()
    try {
      await h.offer(INITIAL_SDP)
      h.native.rejectNextCandidate = true
      await h.candidate({ sdpMid: '1', sdpMLineIndex: 1 })
      expect(h.native.addIceCandidate).toHaveBeenCalledTimes(1)
      expect(h.error).toHaveBeenCalledExactlyOnceWith(NATIVE_ERROR)
    } finally {
      h.peer.destroy()
    }
  })
})
