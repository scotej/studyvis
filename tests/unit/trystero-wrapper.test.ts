import { beforeEach, describe, expect, test, vi } from 'vitest'

// The integration tests mock `@/lib/trystero` and substitute their own
// in-process bus, so the real wrapper's fanout/unsubscribe semantics are
// never exercised there. This file mocks the underlying `trystero` package
// so we can drive `wrapRoom` directly through the public `joinTopic` entry.

type JoinHandler = (peerId: string) => void
type LeaveHandler = (peerId: string) => void
type StreamHandler = (
  stream: MediaStream,
  peerId: string,
  metadata?: unknown
) => void

const captured: {
  onPeerJoin: JoinHandler | null
  onPeerLeave: LeaveHandler | null
  onPeerStream: StreamHandler | null
  config: Record<string, unknown> | null
  callbacks: Record<string, unknown> | null
} = {
  onPeerJoin: null,
  onPeerLeave: null,
  onPeerStream: null,
  config: null,
  callbacks: null,
}

const fakeSockets: Record<string, { readyState: number; url: string }> = {}

vi.mock('trystero', () => ({
  selfId: 'self-fixture',
  getRelaySockets: () => fakeSockets,
  joinRoom: (
    config: Record<string, unknown>,
    _topic: string,
    callbacks: Record<string, unknown> | undefined
  ) => {
    captured.config = config
    captured.callbacks = callbacks ?? null
    return {
      onPeerJoin: (fn: JoinHandler) => {
        captured.onPeerJoin = fn
      },
      onPeerLeave: (fn: LeaveHandler) => {
        captured.onPeerLeave = fn
      },
      onPeerStream: (fn: StreamHandler) => {
        captured.onPeerStream = fn
      },
      makeAction: () => [vi.fn(), vi.fn()],
      addStream: vi.fn(),
      removeStream: vi.fn(),
      getPeers: () => ({}),
      leave: vi.fn(async () => {}),
    }
  },
}))

const { joinTopic, getRelaySocketMap } = await import('@/lib/trystero')
const { DEFAULT_RELAY_URLS } = await import('@/lib/trystero/relays')

beforeEach(() => {
  captured.onPeerJoin = null
  captured.onPeerLeave = null
  captured.onPeerStream = null
  captured.config = null
  captured.callbacks = null
  for (const k of Object.keys(fakeSockets)) delete fakeSockets[k]
})

describe('trystero wrapRoom fanout', () => {
  test('multiple onPeerJoin subscribers all fire for the same peer event', () => {
    const room = joinTopic({ topic: 't', password: 'p' })
    const a = vi.fn()
    const b = vi.fn()
    room.onPeerJoin(a)
    room.onPeerJoin(b)
    captured.onPeerJoin?.('peer-1')
    expect(a).toHaveBeenCalledWith('peer-1')
    expect(b).toHaveBeenCalledWith('peer-1')
  })

  test('unsubscribe removes only that subscriber; others keep firing', () => {
    const room = joinTopic({ topic: 't', password: 'p' })
    const a = vi.fn()
    const b = vi.fn()
    const unsubA = room.onPeerJoin(a)
    room.onPeerJoin(b)
    unsubA()
    captured.onPeerJoin?.('peer-2')
    expect(a).not.toHaveBeenCalled()
    expect(b).toHaveBeenCalledWith('peer-2')
  })

  // F1 contract: the JoinErrorHandler comment promises a thrown handler
  // never crashes the room — which also means one throwing subscriber must
  // not starve the subscribers registered after it (cap-evict, hello
  // re-send, and stream binding share these fan-outs).
  test('a throwing subscriber does not starve later subscribers or the room', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const room = joinTopic({ topic: 't', password: 'p' })
    const boom = vi.fn(() => {
      throw new Error('subscriber exploded')
    })
    const after = vi.fn()
    room.onPeerJoin(boom)
    room.onPeerJoin(after)
    expect(() => captured.onPeerJoin?.('peer-3')).not.toThrow()
    expect(boom).toHaveBeenCalled()
    expect(after).toHaveBeenCalledWith('peer-3')
    expect(errSpy).toHaveBeenCalled()
    errSpy.mockRestore()
  })

  test('onPeerLeave fans out and unsubscribe is independent of onPeerJoin', () => {
    const room = joinTopic({ topic: 't', password: 'p' })
    const left = vi.fn()
    const joined = vi.fn()
    const unsubLeft = room.onPeerLeave(left)
    room.onPeerJoin(joined)
    captured.onPeerLeave?.('peer-3')
    expect(left).toHaveBeenCalledWith('peer-3')
    unsubLeft()
    captured.onPeerLeave?.('peer-4')
    expect(left).toHaveBeenCalledTimes(1)
    captured.onPeerJoin?.('peer-5')
    expect(joined).toHaveBeenCalledWith('peer-5')
  })

  test('onPeerStream fans out with stream + peerId + metadata', () => {
    const room = joinTopic({ topic: 't', password: 'p' })
    const a = vi.fn()
    const b = vi.fn()
    room.onPeerStream(a)
    const unsubB = room.onPeerStream(b)
    const fakeStream = {} as MediaStream
    captured.onPeerStream?.(fakeStream, 'peer-6', { kind: 'cam' })
    expect(a).toHaveBeenCalledWith(fakeStream, 'peer-6', { kind: 'cam' })
    expect(b).toHaveBeenCalledWith(fakeStream, 'peer-6', { kind: 'cam' })
    unsubB()
    captured.onPeerStream?.(fakeStream, 'peer-7', undefined)
    expect(b).toHaveBeenCalledTimes(1)
    expect(a).toHaveBeenCalledTimes(2)
  })
})

describe('trystero joinTopic ICE forwarding', () => {
  test('forwards turnConfig and rtcConfig to joinRoom under the studyvis appId', () => {
    const turnConfig = [
      { urls: 'turn:example.test:3478', username: 'u', credential: 'c' },
    ]
    const rtcConfig = { iceTransportPolicy: 'relay' as const }
    joinTopic({ topic: 't', password: 'p', turnConfig, rtcConfig })
    expect(captured.config).toMatchObject({
      appId: 'studyvis',
      password: 'p',
      turnConfig,
      rtcConfig,
    })
  })

  test('omits TURN/rtc config when the caller provides none', () => {
    joinTopic({ topic: 't', password: 'p' })
    expect(captured.config?.turnConfig).toBeUndefined()
    expect(captured.config?.rtcConfig).toBeUndefined()
  })
})

describe('trystero joinTopic relay config', () => {
  test('pins DEFAULT_RELAY_URLS when the caller provides no relayConfig', () => {
    joinTopic({ topic: 't', password: 'p' })
    expect(captured.config?.relayConfig).toEqual({ urls: DEFAULT_RELAY_URLS })
  })

  test('forwards a caller-provided relayConfig (explicit urls win over the default)', () => {
    const relayConfig = { urls: ['wss://relay.example.test'], redundancy: 3 }
    joinTopic({ topic: 't', password: 'p', relayConfig })
    expect(captured.config?.relayConfig).toEqual(relayConfig)
  })

  test('default-merges the curated urls when the caller omits them', () => {
    // A partial relayConfig (e.g. redundancy only) must NOT bypass the pin —
    // urls always defaults to the curated list when absent.
    joinTopic({ topic: 't', password: 'p', relayConfig: { redundancy: 3 } })
    expect(captured.config?.relayConfig).toEqual({
      urls: DEFAULT_RELAY_URLS,
      redundancy: 3,
    })
  })
})

describe('F1: joinTopic onJoinError forwarding', () => {
  test('forwards a config-level onJoinError to trystero callbacks', () => {
    const onJoinError = vi.fn()
    joinTopic({ topic: 't', password: 'p', onJoinError })
    expect(captured.callbacks?.onJoinError).toBe(onJoinError)
  })

  test('omits callbacks entirely when no onJoinError is provided', () => {
    joinTopic({ topic: 't', password: 'p' })
    expect(captured.callbacks).toBeNull()
  })

  test('the forwarded handler receives trystero JoinError details', () => {
    const onJoinError = vi.fn()
    joinTopic({ topic: 't', password: 'p', onJoinError })
    const details = {
      error: 'incorrect room password',
      appId: 'studyvis',
      roomId: 't',
      peerId: 'peer-x',
    }
    ;(captured.callbacks?.onJoinError as (d: unknown) => void)(details)
    expect(onJoinError).toHaveBeenCalledWith(details)
  })
})

describe('F2: getRelaySocketMap', () => {
  test('returns the live trystero socket map', () => {
    fakeSockets['wss://relay.a'] = { readyState: 1, url: 'wss://relay.a' }
    fakeSockets['wss://relay.b'] = { readyState: 0, url: 'wss://relay.b' }
    const map = getRelaySocketMap()
    expect(map['wss://relay.a']?.readyState).toBe(1)
    expect(map['wss://relay.b']?.readyState).toBe(0)
  })

  test('returns an empty object when there are no sockets', () => {
    expect(getRelaySocketMap()).toEqual({})
  })
})
