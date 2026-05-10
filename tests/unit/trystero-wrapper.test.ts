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
} = { onPeerJoin: null, onPeerLeave: null, onPeerStream: null }

vi.mock('trystero', () => ({
  selfId: 'self-fixture',
  joinRoom: () => ({
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
  }),
}))

const { joinTopic } = await import('@/lib/trystero')

beforeEach(() => {
  captured.onPeerJoin = null
  captured.onPeerLeave = null
  captured.onPeerStream = null
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
