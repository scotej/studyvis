import { afterEach, describe, expect, test, vi } from 'vitest'

import { createManagedTurnPeerConnection } from '@/lib/webrtc/managedTurnPeerConnection'

const { default: createRoom } = await import(
  new URL(
    '../../node_modules/@trystero-p2p/core/dist/room.mjs',
    import.meta.url
  ).href
)
const { SharedPeerManager } = await import(
  new URL(
    '../../node_modules/@trystero-p2p/core/dist/shared-peer.mjs',
    import.meta.url
  ).href
)

type PeerHandlers = {
  data?: (data: ArrayBuffer) => void
  signal?: (description: RTCSessionDescriptionInit) => void
}
type PeerRegistrar = (peer: unknown, id: string) => void

function setup() {
  let handlers: PeerHandlers = {}
  let changed = () => {}
  let servers: RTCIceServer[] = [
    {
      urls: ['turn:turn.cloudflare.com:3478?transport=udp'],
      username: 'old',
      credential: 'old-password',
    },
  ]
  const frames: { token: string; action: string }[] = []
  class NativeConnection extends EventTarget {
    connectionState = 'connected'
    config: RTCConfiguration
    readonly restartIce = vi.fn(() => {
      handlers.signal?.({
        type: 'offer',
        sdp: 'v=0\r\na=ice-ufrag:new\r\na=ice-pwd:new-password\r\n',
      })
    })

    constructor(config: RTCConfiguration) {
      super()
      this.config = structuredClone(config)
    }
    getConfiguration() {
      return structuredClone(this.config)
    }
    setConfiguration(config: RTCConfiguration) {
      this.config = structuredClone(config)
    }
    async getStats() {
      return new Map([
        [
          'transport',
          {
            id: 'transport',
            type: 'transport',
            selectedCandidatePairId: 'pair',
          },
        ],
        [
          'pair',
          { id: 'pair', type: 'candidate-pair', localCandidateId: 'local' },
        ],
        [
          'local',
          {
            id: 'local',
            type: 'local-candidate',
            candidateType: 'relay',
            url: 'turn:turn.cloudflare.com:3478?transport=udp',
          },
        ],
      ])
    }
    close() {
      this.connectionState = 'closed'
    }
  }
  const Constructor = createManagedTurnPeerConnection(
    NativeConnection as unknown as typeof RTCPeerConnection,
    {
      getIceServers: () => structuredClone(servers),
      subscribeIceServers: (listener) => {
        changed = listener
        return () => {}
      },
    }
  )
  const connection = new Constructor({}) as unknown as NativeConnection
  const peer = {
    created: Date.now(),
    connection,
    get isDead() {
      return connection.connectionState === 'closed'
    },
    channel: { readyState: 'open' },
    getOffer() {},
    signal: vi.fn(),
    destroy() {
      connection.close()
    },
    setHandlers(next: PeerHandlers) {
      handlers = next
    },
    sendData(bytes: Uint8Array) {
      if (bytes[0] !== 1) return
      const tokenSize = (bytes[1] << 8) | bytes[2]
      const payload = bytes.slice(3 + tokenSize)
      frames.push({
        token: new TextDecoder().decode(bytes.subarray(3, 3 + tokenSize)),
        action: new TextDecoder()
          .decode(payload.subarray(0, 32))
          .replaceAll('\0', ''),
      })
      // Only the native boundary is fake: loop back the real framed room
      // actions so the installed handshake and activation logic both run.
      const data = Uint8Array.from(bytes).buffer
      queueMicrotask(() => handlers.data?.(data))
    },
  }
  const manager = new SharedPeerManager()
  const shared = manager.register('studyvis', 'friend', peer, 1_000)
  let registerFirst!: PeerRegistrar
  let registerSecond!: PeerRegistrar
  let releaseFirst!: () => void
  const first = createRoom(
    (register: PeerRegistrar) => {
      registerFirst = register
    },
    () => {},
    () => {},
    {
      onPeerHandshake: () =>
        new Promise<void>((resolve) => {
          releaseFirst = resolve
        }),
      handshakeTimeoutMs: 60_000,
    }
  )
  const second = createRoom(
    (register: PeerRegistrar) => {
      registerSecond = register
    },
    () => {},
    () => {},
    { onPeerHandshake: async () => {}, handshakeTimeoutMs: 60_000 }
  )
  registerFirst(
    manager.bind('first', Promise.resolve('first-token'), shared, {
      onDetach() {},
    }).proxy,
    'friend'
  )
  registerSecond(
    manager.bind('second', Promise.resolve('second-token'), shared, {
      onDetach() {},
    }).proxy,
    'friend'
  )
  return {
    connection,
    first,
    second,
    peer,
    frames,
    releaseFirst: () => releaseFirst(),
    rotate: (username: string) => {
      servers = servers.map((server) => ({ ...server, username }))
      changed()
    },
    close: async () => {
      releaseFirst()
      await Promise.all([first.leave(), second.leave()])
      manager.clear('studyvis', 'friend', { destroyPeer: true })
      connection.close()
    },
  }
}

const fixtures: ReturnType<typeof setup>[] = []
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.close()
})

async function connectedRooms() {
  const fixture = setup()
  fixtures.push(fixture)
  await vi.waitFor(() =>
    expect(Object.keys(fixture.second.getPeers())).toEqual(['friend'])
  )
  expect(fixture.first.getPeers()).toEqual({})
  return fixture
}

describe('PR-499 authenticated shared-room restart routing', () => {
  test('signals through an active room while the original control room is pending', async () => {
    const h = await connectedRooms()
    h.rotate('next')
    await vi.waitFor(() => expect(h.peer.signal).toHaveBeenCalledOnce())
    expect(h.connection.restartIce).toHaveBeenCalledOnce()
    expect(h.frames.filter((frame) => frame.action === '@_signal')).toEqual([
      { token: 'second-token', action: '@_signal' },
    ])
    expect(h.peer.signal).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'offer' }),
      true
    )
    expect(h.first.getPeers()).toEqual({})
  })

  test('hands signaling to another active room when the selected room leaves', async () => {
    const h = await connectedRooms()
    h.rotate('next')
    await vi.waitFor(() => expect(h.peer.signal).toHaveBeenCalledOnce())
    h.releaseFirst()
    await vi.waitFor(() =>
      expect(Object.keys(h.first.getPeers())).toEqual(['friend'])
    )
    await h.second.leave()
    h.rotate('latest')
    await vi.waitFor(() => expect(h.peer.signal).toHaveBeenCalledTimes(2))
    expect(h.frames.filter((frame) => frame.action === '@_signal')).toEqual([
      { token: 'second-token', action: '@_signal' },
      { token: 'first-token', action: '@_signal' },
    ])
  })

  test('defers renewal after the last active room leaves until another room activates', async () => {
    const h = await connectedRooms()
    await h.second.leave()
    h.rotate('next')
    await Promise.resolve()
    await Promise.resolve()
    expect(h.connection.restartIce).not.toHaveBeenCalled()
    h.releaseFirst()
    await vi.waitFor(() => expect(h.peer.signal).toHaveBeenCalledOnce())
    expect(h.connection.restartIce).toHaveBeenCalledOnce()
    expect(h.frames.filter((frame) => frame.action === '@_signal')).toEqual([
      { token: 'first-token', action: '@_signal' },
    ])
  })
})
