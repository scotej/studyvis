// #210 — remote membership changes never terminate the local study session.
// `wireSessionRoom` owns only membership and admission; local Leave and
// explicit forced rejection are the only paths that may invoke teardown.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import {
  MAX_REMOTE_PEERS,
  REJOIN_WINDOW_MS,
  SESSION_FULL_ACTION,
  wireSessionRoom,
} from '@/features/session/lifecycle'
import type { TopicRoom } from '@/lib/trystero'
import { useSessionStore } from '@/stores/sessionStore'

type Listener = (peerId: string) => void
type Receiver = (data: null, peerId: string) => void

function fakeRoom() {
  const joinSubs = new Set<Listener>()
  const leaveSubs = new Set<Listener>()
  const actionReceivers = new Map<string, Receiver>()
  const actionSend = vi.fn(async () => [])
  const room = {
    selfId: 'self',
    makeAction: (namespace: string) => ({
      send: actionSend,
      receive: (fn: Receiver) => actionReceivers.set(namespace, fn),
    }),
    onPeerJoin: (fn: Listener) => {
      joinSubs.add(fn)
      return () => joinSubs.delete(fn)
    },
    onPeerLeave: (fn: Listener) => {
      leaveSubs.add(fn)
      return () => leaveSubs.delete(fn)
    },
    onPeerStream: () => () => {},
    addStream: () => {},
    removeStream: () => {},
    getPeers: () => ({}),
    leave: async () => {},
  } as unknown as TopicRoom
  return {
    room,
    actionSend,
    join(peerId: string) {
      for (const fn of joinSubs) fn(peerId)
    },
    leave(peerId: string) {
      for (const fn of leaveSubs) fn(peerId)
    },
    receiveSessionFull(peerId = 'host') {
      actionReceivers.get(SESSION_FULL_ACTION)?.(null, peerId)
    },
  }
}

function beginActive(room: TopicRoom, leave: () => Promise<void>): void {
  useSessionStore.getState().begin({
    sessionTopic: 'topic',
    sessionPassword: 'password',
    isHost: true,
    startedAt: 1_700_000_000_000,
    startedAtMono: 10,
    room,
    leave,
  })
}

describe('#210 active solo session lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    useSessionStore.getState().reset()
  })

  afterEach(() => {
    useSessionStore.getState().reset()
    vi.useRealTimers()
  })

  test('the last peer leaving keeps the same local session active indefinitely', async () => {
    const harness = fakeRoom()
    const localLeave = vi.fn(async () => {})
    beginActive(harness.room, localLeave)
    const lifecycle = wireSessionRoom(harness.room, {
      isHost: true,
      leave: localLeave,
    })

    harness.join('peer-a')
    harness.leave('peer-a')

    const state = useSessionStore.getState()
    expect(lifecycle.peers()).toEqual([])
    expect(state.status).toBe('active')
    expect(state.room).toBe(harness.room)
    expect(state.leave).toBe(localLeave)
    expect(state.hadAnyPeer).toBe(true)
    expect(vi.getTimerCount()).toBe(0)

    await vi.advanceTimersByTimeAsync(20 * 60_000)
    expect(localLeave).not.toHaveBeenCalled()
    expect(useSessionStore.getState().status).toBe('active')
  })

  test('authenticated peer departure closes overlap but not the local session', () => {
    const harness = fakeRoom()
    const localLeave = vi.fn(async () => {})
    beginActive(harness.room, localLeave)
    wireSessionRoom(harness.room, { isHost: true, leave: localLeave })

    harness.join('peer-a')
    useSessionStore.getState().setPeerHello(
      'peer-a',
      {
        ed_pubkey_hex: 'a'.repeat(64),
        display_name: 'Ada',
        joined_at: 1,
      },
      { wallMs: 1_000, monoMs: 100 }
    )
    harness.leave('peer-a')

    const state = useSessionStore.getState()
    expect(state.status).toBe('active')
    expect(state.peers).toEqual({})
    expect(state.peerPresence['a'.repeat(64)]?.activeSinceMono).toBeNull()
    expect(localLeave).not.toHaveBeenCalled()
  })

  test('a three-person session dropping to one stays active', () => {
    const harness = fakeRoom()
    const localLeave = vi.fn(async () => {})
    beginActive(harness.room, localLeave)
    const lifecycle = wireSessionRoom(harness.room, {
      isHost: true,
      leave: localLeave,
    })

    harness.join('peer-a')
    harness.join('peer-b')
    harness.leave('peer-a')
    harness.leave('peer-b')

    expect(lifecycle.peers()).toEqual([])
    expect(useSessionStore.getState().status).toBe('active')
    expect(localLeave).not.toHaveBeenCalled()
  })

  test('departed peers can reconnect and new peers can join the live room', () => {
    const harness = fakeRoom()
    const localLeave = vi.fn(async () => {})
    beginActive(harness.room, localLeave)
    const lifecycle = wireSessionRoom(harness.room, {
      isHost: true,
      leave: localLeave,
    })

    harness.join('peer-a')
    harness.leave('peer-a')
    harness.join('peer-a')
    expect(lifecycle.peers()).toEqual(['peer-a'])
    harness.leave('peer-a')
    harness.join('peer-new')

    expect(lifecycle.peers()).toEqual(['peer-new'])
    expect(useSessionStore.getState().status).toBe('active')
    expect(localLeave).not.toHaveBeenCalled()
  })

  test('a departed peer frees host capacity for another participant', () => {
    const harness = fakeRoom()
    const localLeave = vi.fn(async () => {})
    beginActive(harness.room, localLeave)
    const lifecycle = wireSessionRoom(harness.room, {
      isHost: true,
      leave: localLeave,
    })

    for (let i = 1; i <= MAX_REMOTE_PEERS; i += 1) {
      harness.join(`peer-${i}`)
    }
    harness.join('rejected')
    expect(lifecycle.peers()).toHaveLength(MAX_REMOTE_PEERS)
    expect(harness.actionSend).toHaveBeenCalledWith(null, 'rejected')

    harness.leave('peer-1')
    harness.join('replacement')
    expect(lifecycle.peers()).toEqual([
      ...Array.from(
        { length: MAX_REMOTE_PEERS - 1 },
        (_, index) => `peer-${index + 2}`
      ),
      'replacement',
    ])
    expect(localLeave).not.toHaveBeenCalled()
  })

  test('unknown and duplicate leave callbacks are inert', () => {
    const harness = fakeRoom()
    const localLeave = vi.fn(async () => {})
    beginActive(harness.room, localLeave)
    const lifecycle = wireSessionRoom(harness.room, {
      isHost: true,
      leave: localLeave,
    })

    harness.leave('ghost')
    harness.join('peer-a')
    harness.leave('peer-a')
    harness.leave('peer-a')

    expect(lifecycle.peers()).toEqual([])
    expect(localLeave).not.toHaveBeenCalled()
  })

  test('session-full still forces the rejected guest to end without Rejoin', () => {
    const harness = fakeRoom()
    const localLeave = vi.fn(async () => {})
    useSessionStore.getState().begin({
      sessionTopic: 'topic',
      sessionPassword: 'password',
      isHost: false,
      startedAt: 1_700_000_000_000,
      room: harness.room,
      leave: localLeave,
    })
    wireSessionRoom(harness.room, { isHost: false, leave: localLeave })

    harness.receiveSessionFull()

    expect(localLeave).toHaveBeenCalledTimes(1)
    expect(useSessionStore.getState().pendingEndReason).toBe('peer')
    expect(useSessionStore.getState().rejoinDeadline).toBeNull()
  })

  test('the old rejoin duration has no delayed survivor-side callback', async () => {
    const harness = fakeRoom()
    const localLeave = vi.fn(async () => {})
    beginActive(harness.room, localLeave)
    wireSessionRoom(harness.room, { isHost: true, leave: localLeave })

    harness.join('peer-a')
    harness.leave('peer-a')
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(REJOIN_WINDOW_MS * 3)

    expect(localLeave).not.toHaveBeenCalled()
    expect(useSessionStore.getState().pendingEndReason).toBeNull()
    expect(useSessionStore.getState().status).toBe('active')
  })
})
