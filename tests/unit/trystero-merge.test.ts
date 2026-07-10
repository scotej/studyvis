import { beforeEach, describe, expect, test, vi } from 'vitest'

// mergeRooms (lib/trystero) races several discovery transports on ONE topic and
// fans a single TopicRoom API over them. These tests mock BOTH the Nostr
// ('trystero') and MQTT ('@trystero-p2p/mqtt') strategies with independently
// drivable rooms, so we can assert: one underlying room per strategy, peerId-
// deduped joins across transports, broadcast sends, and leave-all — with no real
// network. This is the path pairing uses (strategies: ['nostr', 'mqtt']).

type Handler = (peerId: string) => void

type MockRoom = {
  strategy: string
  config: Record<string, unknown>
  joinHandlers: Handler[]
  leaveHandlers: Handler[]
  send: ReturnType<typeof vi.fn>
  receivers: Array<(...args: unknown[]) => void>
  leave: ReturnType<typeof vi.fn>
  emitJoin: (peerId: string) => void
  emitLeave: (peerId: string) => void
}

const rooms: MockRoom[] = []

function makeMockRoom(strategy: string, config: Record<string, unknown>) {
  const room: MockRoom = {
    strategy,
    config,
    joinHandlers: [],
    leaveHandlers: [],
    send: vi.fn(async () => []),
    receivers: [],
    leave: vi.fn(async () => {}),
    emitJoin: (peerId) => room.joinHandlers.forEach((h) => h(peerId)),
    emitLeave: (peerId) => room.leaveHandlers.forEach((h) => h(peerId)),
  }
  rooms.push(room)
  return {
    onPeerJoin: (fn: Handler) => {
      room.joinHandlers.push(fn)
    },
    onPeerLeave: (fn: Handler) => {
      room.leaveHandlers.push(fn)
    },
    onPeerStream: () => {},
    makeAction: () => [
      room.send,
      (cb: (...args: unknown[]) => void) => {
        room.receivers.push(cb)
      },
    ],
    addStream: vi.fn(),
    removeStream: vi.fn(),
    getPeers: () => ({}),
    leave: room.leave,
  }
}

vi.mock('trystero', () => ({
  selfId: 'self-fixture',
  getRelaySockets: () => ({}),
  joinRoom: (config: Record<string, unknown>) => makeMockRoom('nostr', config),
}))

vi.mock('@trystero-p2p/mqtt', () => ({
  joinRoom: (config: Record<string, unknown>) => makeMockRoom('mqtt', config),
}))

const { joinTopic } = await import('@/lib/trystero')

const byStrategy = (s: string) => rooms.find((r) => r.strategy === s)!

beforeEach(() => {
  rooms.length = 0
})

describe('joinTopic single-strategy (default)', () => {
  test('opens exactly one Nostr room and no MQTT room when strategies omitted', () => {
    joinTopic({ topic: 't', password: 'p' })
    expect(rooms).toHaveLength(1)
    expect(rooms[0].strategy).toBe('nostr')
  })
})

describe('joinTopic multi-strategy race + mergeRooms', () => {
  test('opens one underlying room per requested strategy', () => {
    joinTopic({ topic: 't', password: 'p', strategies: ['nostr', 'mqtt'] })
    expect(rooms.map((r) => r.strategy).sort()).toEqual(['mqtt', 'nostr'])
  })

  test('does NOT forward the Nostr relayConfig to the MQTT room', () => {
    joinTopic({
      topic: 't',
      password: 'p',
      strategies: ['nostr', 'mqtt'],
      relayConfig: { urls: ['wss://relay.example.test'] },
    })
    expect(byStrategy('nostr').config.relayConfig).toEqual({
      urls: ['wss://relay.example.test'],
    })
    expect(byStrategy('mqtt').config.relayConfig).toBeUndefined()
    // both still carry the shared room identity + WebRTC params
    expect(byStrategy('mqtt').config).toMatchObject({
      appId: 'studyvis',
      password: 'p',
    })
  })

  test('onPeerJoin is deduped by peerId across transports (first transport wins)', () => {
    const room = joinTopic({
      topic: 't',
      password: 'p',
      strategies: ['nostr', 'mqtt'],
    })
    const joined = vi.fn()
    room.onPeerJoin(joined)

    // Same peer appears on BOTH transports — app callback must fire once.
    byStrategy('nostr').emitJoin('peer-1')
    byStrategy('mqtt').emitJoin('peer-1')
    expect(joined).toHaveBeenCalledTimes(1)
    expect(joined).toHaveBeenCalledWith('peer-1')

    // A different peer (seen only on MQTT) fires independently.
    byStrategy('mqtt').emitJoin('peer-2')
    expect(joined).toHaveBeenCalledTimes(2)
    expect(joined).toHaveBeenLastCalledWith('peer-2')
  })

  test('a peer that left can rejoin and fire again (dedup set cleared on leave)', () => {
    const room = joinTopic({
      topic: 't',
      password: 'p',
      strategies: ['nostr', 'mqtt'],
    })
    const joined = vi.fn()
    const left = vi.fn()
    room.onPeerJoin(joined)
    room.onPeerLeave(left)

    byStrategy('nostr').emitJoin('peer-1')
    expect(joined).toHaveBeenCalledTimes(1)
    byStrategy('nostr').emitLeave('peer-1')
    expect(left).toHaveBeenCalledWith('peer-1')
    byStrategy('mqtt').emitJoin('peer-1')
    expect(joined).toHaveBeenCalledTimes(2)
  })

  // #47 C1 — refcounted peer tracking for long-lived dual-strategy rooms.
  test('one transport dropping does NOT fire leave while the other still holds the peer', () => {
    const room = joinTopic({
      topic: 't',
      password: 'p',
      strategies: ['nostr', 'mqtt'],
    })
    const joined = vi.fn()
    const left = vi.fn()
    room.onPeerJoin(joined)
    room.onPeerLeave(left)

    byStrategy('nostr').emitJoin('peer-1')
    byStrategy('mqtt').emitJoin('peer-1')
    expect(joined).toHaveBeenCalledTimes(1)

    // Nostr blips away — the peer is still on MQTT, so no leave...
    byStrategy('nostr').emitLeave('peer-1')
    expect(left).not.toHaveBeenCalled()

    // ...and the LAST transport dropping fires exactly one leave.
    byStrategy('mqtt').emitLeave('peer-1')
    expect(left).toHaveBeenCalledTimes(1)
    expect(left).toHaveBeenCalledWith('peer-1')

    // A rejoin on either transport counts as a fresh join.
    byStrategy('mqtt').emitJoin('peer-1')
    expect(joined).toHaveBeenCalledTimes(2)
  })

  test('multiple subscribers all receive join/leave (construction-time fan-out)', () => {
    const room = joinTopic({
      topic: 't',
      password: 'p',
      strategies: ['nostr', 'mqtt'],
    })
    const joinedA = vi.fn()
    const joinedB = vi.fn()
    room.onPeerJoin(joinedA)
    room.onPeerJoin(joinedB)
    byStrategy('nostr').emitJoin('peer-1')
    expect(joinedA).toHaveBeenCalledTimes(1)
    expect(joinedB).toHaveBeenCalledTimes(1)
  })

  test('makeAction send broadcasts to every transport; receive registers on every transport', async () => {
    const room = joinTopic({
      topic: 't',
      password: 'p',
      strategies: ['nostr', 'mqtt'],
    })
    const action = room.makeAction<{ hi: string }>('hello')

    await action.send({ hi: 'there' })
    expect(byStrategy('nostr').send).toHaveBeenCalledWith(
      { hi: 'there' },
      undefined,
      undefined,
      undefined
    )
    expect(byStrategy('mqtt').send).toHaveBeenCalledWith(
      { hi: 'there' },
      undefined,
      undefined,
      undefined
    )

    const onData = vi.fn()
    action.receive(onData)
    expect(byStrategy('nostr').receivers).toContain(onData)
    expect(byStrategy('mqtt').receivers).toContain(onData)
  })

  test('leave() tears down every transport', async () => {
    const room = joinTopic({
      topic: 't',
      password: 'p',
      strategies: ['nostr', 'mqtt'],
    })
    await room.leave()
    expect(byStrategy('nostr').leave).toHaveBeenCalledTimes(1)
    expect(byStrategy('mqtt').leave).toHaveBeenCalledTimes(1)
  })

  test('merged room reports the shared selfId', () => {
    const room = joinTopic({
      topic: 't',
      password: 'p',
      strategies: ['nostr', 'mqtt'],
    })
    expect(room.selfId).toBe('self-fixture')
  })
})
