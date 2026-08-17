import { describe, expect, test, vi } from 'vitest'

const { default: createRoom } = await import(
  new URL(
    '../../node_modules/@trystero-p2p/core/dist/room.mjs',
    import.meta.url
  ).href
)
const { createStrategy } = await import(
  new URL(
    '../../node_modules/@trystero-p2p/core/dist/index.mjs',
    import.meta.url
  ).href
)
const { SharedPeerManager } = await import(
  new URL(
    '../../node_modules/@trystero-p2p/core/dist/shared-peer.mjs',
    import.meta.url
  ).href
)
const { OfferPool } = await import(
  new URL(
    '../../node_modules/@trystero-p2p/core/dist/offer-pool.mjs',
    import.meta.url
  ).href
)

const decoder = new TextDecoder()

function pendingPeer(args: {
  destroyError?: Error
  leaveError: Error
  synchronouslyClose?: boolean
  blockedLeaveSend?: boolean
}) {
  let handlers: { close?: () => void } | undefined
  const closeCallbackRuns = vi.fn()
  return {
    destroy: vi.fn(() => {
      if (args.destroyError) throw args.destroyError
      if (args.synchronouslyClose) handlers?.close?.()
    }),
    sendData: vi.fn((data: Uint8Array) => {
      const actionType = decoder
        .decode(data.subarray(0, 32))
        .replaceAll('\0', '')
      if (actionType === '@_leave') throw args.leaveError
    }),
    ...(args.blockedLeaveSend
      ? {
          channel: {
            readyState: 'open',
            bufferedAmount: 1,
            bufferedAmountLowThreshold: 0,
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
          },
        }
      : {}),
    setHandlers: vi.fn((next) => {
      const nextHandlers = next as { close?: () => void }
      handlers = {
        ...nextHandlers,
        ...(nextHandlers.close
          ? {
              close: () => {
                closeCallbackRuns()
                nextHandlers.close?.()
              },
            }
          : {}),
      }
    }),
    closeCallbackRuns,
  }
}

describe('patched Trystero room leave cleanup', () => {
  test('caches a failed leave while cleaning every pending peer exactly once', async () => {
    const leaveError = new Error('leave notification failed')
    const cleanupError = new Error('peer destroy failed')
    let registerPeer: ((peer: unknown, peerId: string) => void) | undefined
    const onSelfLeave = vi.fn()
    const room = createRoom(
      (register: (peer: unknown, peerId: string) => void) => {
        registerPeer = register
      },
      vi.fn(),
      onSelfLeave,
      {
        // Keep both peers pending so @_leave must retain sendToPending.
        onPeerHandshake: () => new Promise<void>(() => {}),
        handshakeTimeoutMs: 60_000,
      }
    )
    const firstPeer = pendingPeer({ leaveError })
    const secondPeer = pendingPeer({
      leaveError,
      destroyError: cleanupError,
    })
    registerPeer?.(firstPeer, 'pending-a')
    registerPeer?.(secondPeer, 'pending-b')

    const firstLeave = room.leave()
    const secondLeave = room.leave()

    expect(secondLeave).toBe(firstLeave)
    await expect(firstLeave).rejects.toBe(leaveError)
    await expect(secondLeave).rejects.toBe(leaveError)

    // The signaling error wins over cleanup failures, but each pending peer is
    // still destroyed and cleared by the one cached leave attempt.
    expect(firstPeer.sendData).toHaveBeenCalledTimes(1)
    expect(secondPeer.sendData).toHaveBeenCalledTimes(1)
    expect(firstPeer.destroy).toHaveBeenCalledTimes(1)
    expect(secondPeer.destroy).toHaveBeenCalledTimes(1)
    expect(onSelfLeave).toHaveBeenCalledTimes(1)

    const repeatedLeave = room.leave()
    expect(repeatedLeave).toBe(firstLeave)
    await expect(repeatedLeave).rejects.toBe(leaveError)
    expect(firstPeer.sendData).toHaveBeenCalledTimes(1)
    expect(secondPeer.destroy).toHaveBeenCalledTimes(1)
    expect(onSelfLeave).toHaveBeenCalledTimes(1)
  })

  test('clears peer state before a synchronous destroy close callback', async () => {
    const leaveError = new Error('leave notification failed')
    let registerPeer: ((peer: unknown, peerId: string) => void) | undefined
    const room = createRoom(
      (register: (peer: unknown, peerId: string) => void) => {
        registerPeer = register
      },
      vi.fn(),
      vi.fn(),
      { onPeerHandshake: () => new Promise<void>(() => {}) }
    )
    const peer = pendingPeer({ leaveError, synchronouslyClose: true })
    registerPeer?.(peer, 'pending')

    await expect(room.leave()).rejects.toBe(leaveError)
    expect(peer.setHandlers).toHaveBeenCalled()
    expect(peer.closeCallbackRuns).toHaveBeenCalledTimes(1)
    expect(peer.destroy).toHaveBeenCalledTimes(1)
  })

  test('bounds a backpressured leave notification before room cleanup', async () => {
    vi.useFakeTimers()
    try {
      const leaveError = new Error('leave notification failed')
      let registerPeer: ((peer: unknown, peerId: string) => void) | undefined
      const onSelfLeave = vi.fn()
      const room = createRoom(
        (register: (peer: unknown, peerId: string) => void) => {
          registerPeer = register
        },
        vi.fn(),
        onSelfLeave,
        { onPeerHandshake: () => new Promise<void>(() => {}) }
      )
      const peer = pendingPeer({ leaveError, blockedLeaveSend: true })
      registerPeer?.(peer, 'backpressured')

      const firstLeave = room.leave()
      const secondLeave = room.leave()
      expect(secondLeave).toBe(firstLeave)
      await vi.advanceTimersByTimeAsync(1_099)
      await expect(firstLeave).resolves.toBeUndefined()
      expect(peer.destroy).toHaveBeenCalledTimes(1)
      expect(onSelfLeave).toHaveBeenCalledTimes(1)
      expect(room.leave()).toBe(firstLeave)
    } finally {
      vi.useRealTimers()
    }
  })

  test('keeps leave bounded while safely cleaning a deferred subscription', async () => {
    vi.useFakeTimers()
    try {
      const unsubscribeError = new Error('unsubscribe failed')
      const unsubscribe = vi.fn(() => {
        throw unsubscribeError
      })
      let resolveSubscription: (unsubscribe: () => void) => void
      const subscription = new Promise<() => void>((resolve) => {
        resolveSubscription = resolve
      })
      const joinRoom = createStrategy({
        init: () => ({}),
        subscribe: () => subscription,
        announce: async () => 60_000,
      })
      const room = joinRoom(
        { appId: 'deferred-unsubscribe-app', passive: true },
        'same-room'
      )

      const leave = room.leave()
      await vi.advanceTimersByTimeAsync(99)
      await expect(leave).resolves.toBeUndefined()
      expect(unsubscribe).not.toHaveBeenCalled()

      resolveSubscription!(unsubscribe)
      // The deferred cleanup can only run once the strategy's own topic
      // promises resolve, and those are WebCrypto digests that settle off the
      // timer queue. One tick is usually enough and occasionally is not, so
      // give the event loop a bounded number of real turns instead.
      for (let i = 0; i < 20 && unsubscribe.mock.calls.length === 0; i += 1) {
        await vi.advanceTimersByTimeAsync(0)
      }
      expect(unsubscribe).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  test('finishes remaining shared cleanup when offer-pool destruction fails', async () => {
    const cleanupError = new Error('offer pool destroy failed')
    const cleanupRoomPresenceHandler = vi.fn()
    const setRoomPresenceHandler = vi
      .spyOn(SharedPeerManager.prototype, 'setRoomPresenceHandler')
      .mockReturnValue(cleanupRoomPresenceHandler)
    const originalDestroy = OfferPool.prototype.destroy
    const destroy = vi.spyOn(OfferPool.prototype, 'destroy')
    destroy.mockImplementation(function (this: InstanceType<typeof OfferPool>) {
      originalDestroy.call(this)
      throw cleanupError
    })
    try {
      const joinRoom = createStrategy({
        init: () => ({}),
        subscribe: async () => () => {},
        announce: async () => 60_000,
      })
      const config = { appId: 'pool-destroy-failure-app', passive: true }
      const firstRoom = joinRoom(config, 'same-room')

      await expect(firstRoom.leave()).rejects.toBe(cleanupError)
      expect(destroy).toHaveBeenCalledTimes(1)
      expect(cleanupRoomPresenceHandler).toHaveBeenCalledTimes(1)

      destroy.mockRestore()
      const replacementRoom = joinRoom(config, 'same-room')
      expect(replacementRoom).not.toBe(firstRoom)
      await expect(replacementRoom.leave()).resolves.toBeUndefined()
      expect(cleanupRoomPresenceHandler).toHaveBeenCalledTimes(2)
    } finally {
      destroy.mockRestore()
      setRoomPresenceHandler.mockRestore()
    }
  })

  test('evicts a public strategy room when leave-presence cleanup throws', async () => {
    const leaveError = new Error('shared leave-presence failed')
    let failFirstDeparture = true
    class FakeRtc {
      connectionState = 'connected'
      iceConnectionState = 'connected'
      signalingState = 'stable'
      iceGatheringState = 'complete'
      localDescription: RTCSessionDescriptionInit | null = null
      remoteDescription: RTCSessionDescriptionInit | null = null
      onnegotiationneeded: (() => void) | null = null
      onicecandidate: ((event: { candidate: null }) => void) | null = null
      onconnectionstatechange: (() => void) | null = null
      ondatachannel: ((event: { channel: unknown }) => void) | null = null
      ontrack: (() => void) | null = null
      onremovestream: (() => void) | null = null
      createDataChannel() {
        return {
          readyState: 'open',
          bufferedAmount: 0,
          bufferedAmountLowThreshold: 0,
          send: vi.fn(),
          close: vi.fn(),
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
        }
      }
      addEventListener = vi.fn()
      removeEventListener = vi.fn()
      async createOffer() {
        return { type: 'offer' as const, sdp: '' }
      }
      async setLocalDescription(description?: RTCSessionDescriptionInit) {
        this.localDescription = description ?? { type: 'offer', sdp: '' }
      }
      close() {
        this.connectionState = 'closed'
      }
      getSenders() {
        return []
      }
    }
    const sharedPeer = {
      isDead: false,
      connection: {
        connectionState: 'connected',
        iceConnectionState: 'connected',
      },
      channel: { readyState: 'open' },
      sendData: vi.fn((data: Uint8Array) => {
        // Shared-room presence frame: version 2, followed by the isPresent bit.
        if (data[0] === 2 && data[1] === 0 && failFirstDeparture) {
          failFirstDeparture = false
          throw leaveError
        }
      }),
    }
    const shared = {
      appId: 'leave-cache-app',
      peerId: 'shared-peer',
      peer: sharedPeer,
      isClosing: false,
      remoteRoomTokens: new Set<string>(),
    }
    const originalGetMap = SharedPeerManager.prototype.getMap
    const getMap = vi
      .spyOn(SharedPeerManager.prototype, 'getMap')
      .mockImplementation(function (...args: unknown[]) {
        const appId = args[0] as string
        return appId === 'leave-cache-app'
          ? { 'shared-peer': shared }
          : originalGetMap.call(this, appId)
      })
    try {
      const joinRoom = createStrategy({
        init: () => ({}),
        subscribe: async () => () => {},
        announce: async () => 60_000,
      })
      const config = {
        appId: 'leave-cache-app',
        rtcPolyfill: FakeRtc,
      }
      const firstRoom = joinRoom(config, 'same-room')
      // Allow the room namespace to resolve and install its presence record.
      await vi.waitFor(() =>
        expect(sharedPeer.sendData).toHaveBeenCalledWith(expect.any(Uint8Array))
      )

      const firstLeave = firstRoom.leave()
      expect(firstRoom.leave()).toBe(firstLeave)
      await expect(firstLeave).rejects.toBe(leaveError)

      // The failed best-effort departure announcement cannot retain a stale
      // public registry entry. A new room is cacheable independently.
      const replacementRoom = joinRoom(config, 'same-room')
      expect(replacementRoom).not.toBe(firstRoom)
      expect(joinRoom(config, 'same-room')).toBe(replacementRoom)
      await expect(replacementRoom.leave()).resolves.toBeUndefined()
      expect(firstRoom.leave()).toBe(firstLeave)
    } finally {
      getMap.mockRestore()
    }
  })
})
