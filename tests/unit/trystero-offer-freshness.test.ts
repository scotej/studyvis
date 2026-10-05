import { describe, expect, test, vi } from 'vitest'

const { default: createPeer } = await import(
  new URL(
    '../../node_modules/@trystero-p2p/core/dist/peer.mjs',
    import.meta.url
  ).href
)
const { OfferPool, offerTtl } = await import(
  new URL(
    '../../node_modules/@trystero-p2p/core/dist/offer-pool.mjs',
    import.meta.url
  ).href
)
const { createStrategy } = await import(
  new URL(
    '../../node_modules/@trystero-p2p/core/dist/index.mjs',
    import.meta.url
  ).href
)
const { decrypt, genKey } = await import(
  new URL(
    '../../node_modules/@trystero-p2p/core/dist/crypto.mjs',
    import.meta.url
  ).href
)

const DATA_SDP =
  'v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=ice-ufrag:fixture\r\n'

// Models the Chromium result: rolling back an unused data-only offer drops its
// SCTP media section while still producing a syntactically valid SDP offer.
class NativeConnection extends EventTarget {
  connectionState = 'new'
  iceConnectionState = 'new'
  signalingState = 'stable'
  localDescription: RTCSessionDescriptionInit | null = null
  remoteDescription: RTCSessionDescriptionInit | null = null
  rolledBack = false
  closeCalls = 0
  createDataChannel() {
    return { readyState: 'connecting', close() {} }
  }
  async setLocalDescription(description?: RTCSessionDescriptionInit) {
    if (description?.type === 'rollback') this.rolledBack = true
    this.localDescription = description ?? { type: 'offer', sdp: DATA_SDP }
    this.signalingState =
      description?.type === 'rollback' ? 'stable' : 'have-local-offer'
  }
  async createOffer() {
    return { type: 'offer', sdp: this.rolledBack ? 'v=0\r\n' : DATA_SDP }
  }
  restartIce() {}
  close() {
    this.connectionState = 'closed'
    this.iceConnectionState = 'closed'
    this.closeCalls += 1
  }
}

function harness() {
  const peers: ReturnType<typeof createPeer>[] = []
  const pool = new OfferPool(() => {
    const peer = createPeer(true, { rtcPolyfill: NativeConnection })
    peers.push(peer)
    return peer
  })
  const encryptOffer = async (peer: ReturnType<typeof createPeer>) => {
    const offer = await peer.getOffer()
    return offer.sdp
  }
  pool.warmup()
  return {
    peers,
    pool,
    checkout: (count = 1) => pool.checkout(count, false, encryptOffer),
    encryptOffer,
  }
}

describe('#350 unused offer freshness', () => {
  test('expired warm offers are replaced without rolling back their data channels', async () => {
    const h = harness()
    try {
      const expired = h.peers[0]!
      await Promise.all(h.peers.map((peer) => peer.getOffer()))
      h.peers.forEach((peer) => {
        peer.created = Date.now() - offerTtl - 1
      })
      const getOffer = vi.spyOn(expired, 'getOffer')
      const [record] = await h.checkout()
      expect(getOffer).not.toHaveBeenCalled()
      expect(expired.isDead).toBe(true)
      expect((expired.connection as NativeConnection).closeCalls).toBe(1)
      expect(record.peer).toBe(h.peers[20])
      expect(h.peers).toHaveLength(21)
      expect(record.offer).toBe(DATA_SDP)
    } finally {
      h.pool.destroy()
    }
  })

  test('an unaccepted young offer returns its slot as a fresh native connection', async () => {
    const h = harness()
    try {
      const [original] = await h.checkout()
      const getOffer = vi.spyOn(original.peer, 'getOffer')
      const oldClose = vi.fn()
      original.peer.setHandlers({ close: oldClose })
      h.pool.recycle(original.peer)
      expect(getOffer).not.toHaveBeenCalled()
      expect(original.peer.isDead).toBe(true)
      expect(oldClose).not.toHaveBeenCalled()
      expect(h.peers).toHaveLength(21)
      const records = await h.checkout(20)
      const recycled = records.at(-1)!
      expect(recycled.peer).toBe(h.peers[20])
      expect(recycled.peer).not.toBe(original.peer)
      expect(recycled.offer).toBe(DATA_SDP)
    } finally {
      h.pool.destroy()
    }
  })

  test('claiming a leased offer retains the accepted transport', async () => {
    const h = harness()
    try {
      const [leased] = await h.pool.getOffers(1, h.encryptOffer)
      leased.claim()
      const connection = leased.peer.connection as NativeConnection
      connection.remoteDescription = { type: 'answer', sdp: DATA_SDP }
      connection.connectionState = 'connected'
      leased.peer.created = Date.now() - offerTtl - 1
      const records = await h.checkout(1)
      expect(records[0].peer).not.toBe(leased.peer)
      expect(leased.peer.isDead).toBe(false)
      expect(connection.closeCalls).toBe(0)
      expect(h.peers).toHaveLength(20)
      leased.peer.destroy()
    } finally {
      h.pool.destroy()
    }
  })

  test('the strategy cannot restart a selected offer when its age crosses the TTL', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    type Record = {
      peer: ReturnType<typeof createPeer>
      offer: string
      claim: () => void
    }
    let getOffers!: (count: number) => Promise<Record[]>
    let subscribed!: () => void
    const ready = new Promise<void>((resolve) => {
      subscribed = resolve
    })
    const joinRoom = createStrategy({
      init: () => ({}),
      subscribe: (
        _relay: unknown,
        _root: unknown,
        _self: unknown,
        _onMessage: unknown,
        offers: typeof getOffers
      ) => {
        getOffers = offers
        subscribed()
        return () => {}
      },
      announce: async () => 60_000,
    })
    const now = Date.now()
    const appId = 'offer-boundary-fixture'
    const roomId = 'room'
    const password = 'fixture'
    const room = joinRoom(
      { appId, password, rtcPolyfill: NativeConnection },
      roomId
    )
    const shift = OfferPool.prototype.shift
    const shifting = vi
      .spyOn(OfferPool.prototype, 'shift')
      .mockImplementation(function (
        this: InstanceType<typeof OfferPool>,
        ...args: unknown[]
      ) {
        const peers = shift.apply(this, args)
        vi.setSystemTime(Date.now() + 2)
        return peers
      })
    let record: Record | undefined
    try {
      await ready
      vi.setSystemTime(now + offerTtl - 1)
      ;[record] = await getOffers(1)
      record!.claim()
      const plain = await decrypt(
        genKey(password, appId, roomId),
        record!.offer
      )
      expect(shifting).toHaveBeenCalledOnce()
      expect(plain).toBe(DATA_SDP)
      expect((record!.peer.connection as NativeConnection).rolledBack).toBe(
        false
      )
    } finally {
      shifting.mockRestore()
      await room.leave()
      record?.peer.destroy()
      vi.useRealTimers()
    }
  })
})
