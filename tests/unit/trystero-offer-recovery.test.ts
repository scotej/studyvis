import { afterEach, describe, expect, test, vi } from 'vitest'

const { default: createPeer } = await import(
  new URL(
    '../../node_modules/@trystero-p2p/core/dist/peer.mjs',
    import.meta.url
  ).href
)
const { OfferPool } = await import(
  new URL(
    '../../node_modules/@trystero-p2p/core/dist/offer-pool.mjs',
    import.meta.url
  ).href
)
const { createSignalHandler, resetOfferState } = await import(
  new URL(
    '../../node_modules/@trystero-p2p/core/dist/signal-handler.mjs',
    import.meta.url
  ).href
)

const OFFER = {
  type: 'offer' as const,
  sdp: 'v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n',
}
const NATIVE_ERROR = new DOMException(
  'synthetic native SDP failure',
  'OperationError'
)
const NATIVE_CONSTRUCTOR_ERROR = new DOMException(
  'synthetic native resource exhaustion',
  'UnknownError'
)

// Only the native operation boundary is injected. The installed PeerHandle,
// OfferPool and signal handler own rejection, destruction and all retries.
class NativeConnection extends EventTarget {
  static failuresRemaining = 0
  static constructorFailuresRemaining = 0
  static created: NativeConnection[] = []
  connectionState = 'new'
  iceConnectionState = 'new'
  signalingState = 'stable'
  localDescription: RTCSessionDescriptionInit | null = null
  remoteDescription: RTCSessionDescriptionInit | null = null
  closeCalls = 0
  rejectNextDescription = false
  private readonly rejectInitialDescription: boolean
  readonly channel = {
    readyState: 'connecting',
    close() {
      this.readyState = 'closed'
    },
    send: vi.fn(),
    onopen: null as (() => void) | null,
  }

  constructor() {
    super()
    if (NativeConnection.constructorFailuresRemaining > 0) {
      NativeConnection.constructorFailuresRemaining -= 1
      throw NATIVE_CONSTRUCTOR_ERROR
    }
    this.rejectInitialDescription = NativeConnection.failuresRemaining > 0
    NativeConnection.failuresRemaining = Math.max(
      0,
      NativeConnection.failuresRemaining - 1
    )
    NativeConnection.created.push(this)
  }

  createDataChannel() {
    return this.channel
  }
  async setLocalDescription(description?: RTCSessionDescriptionInit) {
    if (
      (this.localDescription === null && this.rejectInitialDescription) ||
      this.rejectNextDescription
    ) {
      this.rejectNextDescription = false
      throw NATIVE_ERROR
    }
    this.localDescription = description ?? OFFER
    this.signalingState = 'have-local-offer'
  }
  async createOffer() {
    return OFFER
  }
  restartIce() {}
  async setRemoteDescription(description: RTCSessionDescriptionInit) {
    this.remoteDescription = description
    this.signalingState = 'stable'
  }
  close() {
    this.closeCalls += 1
    this.connectionState = 'closed'
    this.iceConnectionState = 'closed'
    this.channel.readyState = 'closed'
  }
}

async function encryptOffer(peer: ReturnType<typeof createPeer>) {
  const offer = await peer.getOffer()
  if (!offer || offer.type !== 'offer') throw new Error('failed to get offer')
  return offer.sdp
}

function harness(failures: number, cipher = encryptOffer) {
  NativeConnection.created = []
  NativeConnection.failuresRemaining = failures
  NativeConnection.constructorFailuresRemaining = 0
  const peers: ReturnType<typeof createPeer>[] = []
  const pool = new OfferPool(() => {
    const peer = createPeer(true, { rtcPolyfill: NativeConnection })
    peers.push(peer)
    return peer
  })
  const ctx = {
    appId: 'studyvis',
    roomId: 'session',
    config: {},
    peerStates: {},
    rootTopicPlaintext: 'fixture-root',
    rootTopicP: Promise.resolve('root'),
    selfTopicP: Promise.resolve('self'),
    isLeaving: () => false,
    isPassive: false,
    isActive: true,
    sharedPeers: { get: () => undefined },
    offerPool: pool,
    encryptOffer: cipher,
    toPlain: async (signal: unknown) => signal,
    toCipher: async (signal: unknown) => signal,
    onJoinError: vi.fn(),
    connectPeer: vi.fn(),
    disconnectPeer: vi.fn(),
    checkDeactivate: vi.fn(),
    announceIntervals: [5_333],
  }
  // Every generated selfId sorts before this fixture's remote ID.
  const peerId = '~remote-fixture'
  const handle = createSignalHandler(ctx)(0)
  const sent: Array<{ offer?: string; offerId?: string }> = []
  return {
    pool,
    ctx,
    peers,
    peerId,
    sent,
    state: () =>
      (
        ctx.peerStates as Record<
          string,
          {
            offerInitPromise: Promise<unknown> | null
            offerPeer: ReturnType<typeof createPeer> | null
            offerId: string | null
            offerSdp: string | null
            offerExpiryTimer: unknown
            offerRelays: unknown[]
            offerAnswered: boolean
          }
        >
      )[peerId]!,
    announce: () =>
      handle(
        'root',
        JSON.stringify({ peerId }),
        (_topic: string, payload: string) => sent.push(JSON.parse(payload))
      ),
    answer: () =>
      handle(
        'self',
        JSON.stringify({ peerId, answer: 'legacy-answer' }),
        () => {}
      ),
    close() {
      for (const state of Object.values(ctx.peerStates))
        resetOfferState(state, pool)
      pool.destroy()
      peers.forEach((peer) => {
        if (!peer.isDead) peer.destroy()
      })
    },
  }
}

afterEach(() => vi.restoreAllMocks())

describe('#350 pooled offer failure recovery', () => {
  test('rejects an initial native failure and retries with a new owned connection', async () => {
    const h = harness(1)
    try {
      await h.announce()
      expect(NativeConnection.created).toHaveLength(2)
      expect(NativeConnection.created[0]?.closeCalls).toBe(1)
      expect(h.state().offerPeer).toBe(h.peers[1])
      expect(h.sent).toEqual([
        {
          peerId: expect.any(String),
          offerId: expect.any(String),
          offer: OFFER.sdp,
        },
      ])
      // An older peer's answer has no offerId; it remains accepted unchanged.
      await h.answer()
      expect(NativeConnection.created[1]?.remoteDescription).toEqual({
        type: 'answer',
        sdp: 'legacy-answer',
      })
      expect(h.state().offerAnswered).toBe(true)
    } finally {
      h.close()
    }
  })

  test('clears failed announcement initialization so repeated failures can later recover', async () => {
    const h = harness(20)
    try {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        await expect(h.announce()).resolves.toBeUndefined()
        expect(h.state().offerInitPromise).toBeNull()
        expect(h.state().offerPeer).toBeNull()
        expect(h.state().offerExpiryTimer).toBeNull()
        expect(h.state().offerRelays).toEqual([])
      }
      expect(h.ctx.onJoinError).toHaveBeenCalledTimes(10)
      expect(h.ctx.onJoinError).toHaveBeenLastCalledWith({
        error: 'failed to create local offer',
        appId: 'studyvis',
        peerId: h.peerId,
        roomId: 'session',
      })
      expect(NativeConnection.created).toHaveLength(20)
      expect(
        NativeConnection.created.every(
          (connection) => connection.closeCalls === 1
        )
      ).toBe(true)
      await h.announce()
      expect(h.sent).toHaveLength(1)
      expect(h.state().offerPeer?.isDead).toBe(false)
      expect(h.state().offerExpiryTimer).not.toBeNull()
    } finally {
      h.close()
    }
  })

  test('checkout rejects with the native error after its one bounded retry', async () => {
    const h = harness(2)
    try {
      await expect(h.pool.checkout(1, false, encryptOffer)).rejects.toBe(
        NATIVE_ERROR
      )
      expect(NativeConnection.created).toHaveLength(2)
      expect(
        NativeConnection.created.every(
          (connection) => connection.closeCalls === 1
        )
      ).toBe(true)
    } finally {
      h.close()
    }
  })

  test('handles a warm offer rejection before any consumer checks it out', async () => {
    const h = harness(1)
    try {
      h.pool.warmup()
      // Let native failure settle before checkout installs its own catch.
      await new Promise((resolve) => setTimeout(resolve, 0))
      const records = await h.pool.checkout(1, false, encryptOffer)
      expect(records).toHaveLength(1)
      expect(records[0].offer).toBe(OFFER.sdp)
      expect(NativeConnection.created[0]?.closeCalls).toBe(1)
    } finally {
      h.close()
    }
  })

  test('a failed recycle allocation clears its owner and the next announcement recovers', async () => {
    const h = harness(0)
    try {
      h.pool.warmup()
      // Exhaust warm slots so recovery must allocate a new native connection.
      await h.pool.checkout(20, false, encryptOffer)
      await h.announce()
      const retired = h.state().offerPeer!
      NativeConnection.constructorFailuresRemaining = 1

      expect(() => resetOfferState(h.state(), h.pool)).not.toThrow()
      expect(retired.isDead).toBe(true)
      expect((retired.connection as NativeConnection).closeCalls).toBe(1)
      expect(h.state().offerPeer).toBeNull()
      expect(h.state().offerId).toBeNull()
      expect(h.state().offerSdp).toBeNull()
      expect(h.state().offerInitPromise).toBeNull()
      expect(h.state().offerExpiryTimer).toBeNull()
      expect(h.state().offerRelays).toEqual([])
      expect(NativeConnection.constructorFailuresRemaining).toBe(0)

      await h.announce()
      const replacement = h.state().offerPeer!
      expect(replacement).not.toBe(retired)
      expect(replacement.isDead).toBe(false)
      expect(h.state().offerExpiryTimer).not.toBeNull()
      expect(NativeConnection.created).toHaveLength(22)
      expect(h.sent).toHaveLength(2)
      expect(h.ctx.onJoinError).not.toHaveBeenCalled()
      await h.answer()
      expect(replacement.connection.remoteDescription).toEqual({
        type: 'answer',
        sdp: 'legacy-answer',
      })
    } finally {
      h.close()
    }
  })

  test('an ICE restart rejection still settles checkout and retries', async () => {
    let restartFirst = true
    const h = harness(0, async (peer) => {
      await peer.getOffer()
      if (restartFirst) {
        restartFirst = false
        ;(peer.connection as NativeConnection).rejectNextDescription = true
        const restarted = await peer.getOffer(true)
        if (!restarted) throw new Error('failed restart')
      }
      return encryptOffer(peer)
    })
    try {
      await h.announce()
      expect(NativeConnection.created).toHaveLength(2)
      expect(NativeConnection.created[0]?.closeCalls).toBe(1)
      expect(h.state().offerPeer).toBe(h.peers[1])
      expect(h.sent).toHaveLength(1)
      expect(h.ctx.onJoinError).not.toHaveBeenCalled()
    } finally {
      h.close()
    }
  })

  test('a superseded checkout rejection cannot clear a newer initialization', async () => {
    let rejectOld!: (error: Error) => void
    let releaseNew!: () => void
    const oldCipher = new Promise<string>((_, reject) => {
      rejectOld = reject
    })
    const newCipher = new Promise<void>((resolve) => {
      releaseNew = resolve
    })
    let calls = 0
    const failure = new Error('old checkout rejected')
    const h = harness(0, async (peer) => {
      calls += 1
      if (calls === 1) return oldCipher
      if (calls === 2) {
        await newCipher
        return encryptOffer(peer)
      }
      throw failure
    })
    try {
      const old = h.announce()
      await vi.waitFor(() => expect(calls).toBe(1))
      resetOfferState(h.state(), h.pool)
      const replacement = h.announce()
      await vi.waitFor(() => expect(calls).toBe(2))
      const replacementInit = h.state().offerInitPromise
      const settled = expect(old).resolves.toBeUndefined()
      rejectOld(failure)
      await settled
      expect(h.state().offerInitPromise).toBe(replacementInit)
      expect(h.state().offerRelays).toHaveLength(1)
      releaseNew()
      await replacement
      expect(h.state().offerPeer).toBe(h.peers[1])
      expect(h.state().offerPeer?.isDead).toBe(false)
      expect(h.sent).toHaveLength(1)
    } finally {
      h.close()
    }
  })

  test('later renegotiation errors keep reaching the registered peer error handler', async () => {
    const h = harness(0)
    try {
      await h.announce()
      const peer = h.state().offerPeer!
      const error = vi.fn()
      peer.setHandlers({ error })
      const connection = peer.connection as NativeConnection & {
        onnegotiationneeded: () => Promise<void>
      }
      connection.rejectNextDescription = true
      await connection.onnegotiationneeded()
      expect(error).toHaveBeenCalledExactlyOnceWith(NATIVE_ERROR)
      await expect(peer.offerPromise).resolves.toEqual(OFFER)
    } finally {
      h.close()
    }
  })
})
