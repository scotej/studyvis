// #325 — failed incoming handshakes must release their native PeerConnections.
// Trystero clears its answering-peer reference when ICE fails, but does not
// close the connection, so retries can exhaust the WebRTC engine's limit.

import { describe, expect, test, vi } from 'vitest'

import { createResilientPeerConnection } from '@/lib/webrtc/resilientPeerConnection'

const { default: createPeer } = await import(
  new URL(
    '../../node_modules/@trystero-p2p/core/dist/peer.mjs',
    import.meta.url
  ).href
)
const { createSignalHandler } = await import(
  new URL(
    '../../node_modules/@trystero-p2p/core/dist/signal-handler.mjs',
    import.meta.url
  ).href
)

class NativeConnection extends EventTarget {
  static created: NativeConnection[] = []

  private connection: RTCPeerConnectionState = 'new'
  private ice: RTCIceConnectionState = 'new'
  iceGatheringState: RTCIceGatheringState = 'complete'
  signalingState: RTCSignalingState = 'stable'
  localDescription: RTCSessionDescriptionInit | null = null
  remoteDescription: RTCSessionDescriptionInit | null = null
  onconnectionstatechange: ((event: Event) => void) | null = null
  closeCalls = 0

  constructor() {
    super()
    NativeConnection.created.push(this)
  }

  get connectionState(): RTCPeerConnectionState {
    return this.connection
  }

  get iceConnectionState(): RTCIceConnectionState {
    return this.ice
  }

  async setRemoteDescription(description: RTCSessionDescriptionInit) {
    this.remoteDescription = description
  }

  async setLocalDescription() {
    this.localDescription = { type: 'answer', sdp: 'local-answer' }
  }

  close() {
    this.closeCalls += 1
    this.connection = 'closed'
    this.ice = 'closed'
  }

  fail() {
    this.connection = 'failed'
    this.ice = 'failed'
    this.dispatchEvent(new Event('connectionstatechange'))
    // Node's EventTarget does not invoke an `onconnectionstatechange` property.
    this.onconnectionstatechange?.(new Event('connectionstatechange'))
    this.dispatchEvent(new Event('iceconnectionstatechange'))
  }

  recover() {
    this.connection = 'connected'
    this.ice = 'connected'
    this.dispatchEvent(new Event('connectionstatechange'))
    this.onconnectionstatechange?.(new Event('connectionstatechange'))
    this.dispatchEvent(new Event('iceconnectionstatechange'))
  }
}

function harness() {
  NativeConnection.created = []
  const rtcPolyfill = createResilientPeerConnection(
    NativeConnection as unknown as typeof RTCPeerConnection
  )
  const peerStates: Record<string, { answeringPeer: unknown }> = {}
  const ctx = {
    appId: 'studyvis',
    roomId: 'test-room',
    rootTopicPlaintext: 'test-root',
    rootTopicP: Promise.resolve('root'),
    selfTopicP: Promise.resolve('self'),
    peerStates,
    isLeaving: () => false,
    isPassive: false,
    isActive: true,
    config: { rtcPolyfill },
    toPlain: async () => ({ type: 'offer', sdp: 'remote-offer' }),
    toCipher: async (signal: unknown) => signal,
    sharedPeers: { get: () => undefined },
    offerPool: {},
    initPeer: createPeer,
    disconnectPeer: () => {},
    checkDeactivate: () => {},
    onJoinError: () => {},
  }
  const handleSignal = createSignalHandler(ctx)(0)
  return {
    peerStates,
    async answerOffer(): Promise<NativeConnection> {
      await handleSignal(
        'root',
        JSON.stringify({ peerId: 'remote-peer', offer: 'encrypted-offer' }),
        () => {}
      )
      const connection = NativeConnection.created.at(-1)
      if (!connection) throw new Error('Trystero did not construct an answer')
      return connection
    },
  }
}

describe('#325 failed Trystero answer cleanup', () => {
  test('closes every failed answer connection across repeated offers', async () => {
    const { answerOffer } = harness()
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const connection = await answerOffer()
      connection.fail()
    }

    await vi.waitFor(() => {
      expect(NativeConnection.created).toHaveLength(30)
      expect(
        NativeConnection.created.every(
          (connection) => connection.closeCalls === 1
        )
      ).toBe(true)
      expect(
        NativeConnection.created.every(
          (connection) => connection.connectionState === 'closed'
        )
      ).toBe(true)
    })
  })

  test('closes an abandoned answer even if its native state recovers immediately', async () => {
    const { answerOffer, peerStates } = harness()
    const connection = await answerOffer()

    connection.fail()
    expect(peerStates['remote-peer']?.answeringPeer).toBeNull()
    connection.recover()

    await vi.waitFor(() => {
      expect(connection.closeCalls).toBe(1)
      expect(connection.connectionState).toBe('closed')
    })
  })
})
