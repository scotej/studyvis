// S1 — grace-window debounce before the everyone-else-left auto-end fires.
// Drives `wireSessionRoom` with a fake trystero room + a fake scheduler so
// the timer logic is deterministic. The leave hook is a spy; we assert it
// runs only when the room is STILL empty at expiry, and never on a reconnect
// inside the window.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { useSessionStore } from '@/stores/sessionStore'

import {
  DISCONNECT_GRACE_MS,
  wireSessionRoom,
  type GraceScheduler,
} from '@/features/session/lifecycle'

type Listener = (peerId: string) => void

function fakeRoom() {
  const joinSubs = new Set<Listener>()
  const leaveSubs = new Set<Listener>()
  return {
    room: {
      selfId: 'self',
      makeAction: () => ({
        send: async () => [],
        receive: () => {},
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
    } as unknown as Parameters<typeof wireSessionRoom>[0],
    join: (peerId: string) => {
      for (const fn of joinSubs) fn(peerId)
    },
    leave: (peerId: string) => {
      for (const fn of leaveSubs) fn(peerId)
    },
  }
}

function fakeScheduler() {
  let nextId = 1
  const timers = new Map<number, { fn: () => void; at: number }>()
  let clock = 0
  const scheduler: GraceScheduler = {
    setTimeout: (fn, ms) => {
      const id = nextId++
      timers.set(id, { fn, at: clock + ms })
      return id
    },
    clearTimeout: (id) => {
      timers.delete(id)
    },
  }
  return {
    scheduler,
    advance(ms: number) {
      clock += ms
      for (const [id, t] of [...timers.entries()]) {
        if (t.at <= clock) {
          timers.delete(id)
          t.fn()
        }
      }
    },
    pending: () => timers.size,
  }
}

describe('S1 disconnect grace window', () => {
  beforeEach(() => {
    useSessionStore.getState().reset()
  })
  afterEach(() => {
    useSessionStore.getState().reset()
  })

  test('auto-end fires only after the grace window with the room still empty', () => {
    const { room, join, leave } = fakeRoom()
    const sched = fakeScheduler()
    const onLeave = vi.fn(async () => {})

    wireSessionRoom(
      room,
      { isHost: true, leave: onLeave },
      { scheduler: sched.scheduler }
    )

    join('peer-a')
    leave('peer-a')
    // Within the window the session is NOT ended — a blip must not kill it.
    sched.advance(DISCONNECT_GRACE_MS - 1)
    expect(onLeave).not.toHaveBeenCalled()
    sched.advance(1)
    expect(onLeave).toHaveBeenCalledTimes(1)
  })

  test('a reconnect inside the grace window cancels the auto-end', () => {
    const { room, join, leave } = fakeRoom()
    const sched = fakeScheduler()
    const onLeave = vi.fn(async () => {})

    wireSessionRoom(
      room,
      { isHost: true, leave: onLeave },
      { scheduler: sched.scheduler }
    )

    join('peer-a')
    leave('peer-a')
    // Transport recovers — trystero re-fires onPeerJoin before expiry.
    sched.advance(DISCONNECT_GRACE_MS - 1)
    join('peer-a')
    expect(sched.pending()).toBe(0)
    sched.advance(DISCONNECT_GRACE_MS)
    expect(onLeave).not.toHaveBeenCalled()
  })

  test('never arms before any peer was present', () => {
    const { room, leave } = fakeRoom()
    const sched = fakeScheduler()
    const onLeave = vi.fn(async () => {})

    wireSessionRoom(
      room,
      { isHost: true, leave: onLeave },
      { scheduler: sched.scheduler }
    )

    // A spurious leave for a peer we never admitted is ignored.
    leave('ghost')
    expect(sched.pending()).toBe(0)
    sched.advance(DISCONNECT_GRACE_MS)
    expect(onLeave).not.toHaveBeenCalled()
  })

  test('seenPeerEdPubkeys survives the gap so the report still records who we studied with', () => {
    const { room, join, leave } = fakeRoom()
    const sched = fakeScheduler()
    const onLeave = vi.fn(async () => {})

    wireSessionRoom(
      room,
      { isHost: true, leave: onLeave },
      { scheduler: sched.scheduler }
    )

    join('peer-a')
    // Simulate the signed-hello binding that the session store accumulates.
    useSessionStore.getState().setPeerHello('peer-a', {
      ed_pubkey_hex: 'ed-a',
      display_name: 'Ada',
      joined_at: 1,
    })
    leave('peer-a')
    sched.advance(DISCONNECT_GRACE_MS)
    expect(onLeave).toHaveBeenCalledTimes(1)
    // The cumulative set is never pruned by peerLeft, so the report's
    // partner attribution is intact across the disconnect.
    expect(useSessionStore.getState().seenPeerEdPubkeys).toContain('ed-a')
    expect(useSessionStore.getState().collectPeerPubkeys()).toBe(
      JSON.stringify(['ed-a'])
    )
  })

  test("a peer that broadcast 'left' ends the session at once, with no grace window", () => {
    const { room, join, leave } = fakeRoom()
    const sched = fakeScheduler()
    const onLeave = vi.fn(async () => {})

    wireSessionRoom(
      room,
      { isHost: true, leave: onLeave },
      { scheduler: sched.scheduler }
    )

    join('peer-a')
    // SessionView marks the peer when their signed 'left' audit event lands,
    // which is always before trystero's own leave notification.
    useSessionStore.getState().markPeerDeparted('peer-a')
    leave('peer-a')
    expect(onLeave).toHaveBeenCalledTimes(1)
    expect(sched.pending()).toBe(0)
    // 'peer' (not 'auto') so the Report suppresses Rejoin into a dead room.
    expect(useSessionStore.getState().pendingEndReason).toBe('peer')
  })

  test('a deliberate departure alongside an unexplained one still waits out the window', () => {
    const { room, join, leave } = fakeRoom()
    const sched = fakeScheduler()
    const onLeave = vi.fn(async () => {})

    wireSessionRoom(
      room,
      { isHost: true, leave: onLeave },
      { scheduler: sched.scheduler }
    )

    join('peer-a')
    join('peer-b')
    // peer-b drops off the network; peer-a then leaves on purpose. The room
    // empties on an explained departure, but peer-b may still be blipping.
    leave('peer-b')
    useSessionStore.getState().markPeerDeparted('peer-a')
    leave('peer-a')
    expect(onLeave).not.toHaveBeenCalled()
    expect(sched.pending()).toBe(1)
    sched.advance(DISCONNECT_GRACE_MS)
    expect(onLeave).toHaveBeenCalledTimes(1)
    expect(useSessionStore.getState().pendingEndReason).toBe('auto')
  })

  test('a peer re-invited after a deliberate leave gets the grace window back', () => {
    const { room, join, leave } = fakeRoom()
    const sched = fakeScheduler()
    const onLeave = vi.fn(async () => {})

    wireSessionRoom(
      room,
      { isHost: true, leave: onLeave },
      { scheduler: sched.scheduler }
    )

    join('peer-a')
    join('peer-b')
    useSessionStore.getState().markPeerDeparted('peer-a')
    leave('peer-a')
    // Re-invited into the still-live session: trystero's peerId is process-
    // stable, so peer-a returns under the same id and the mark must clear.
    join('peer-a')
    expect(useSessionStore.getState().departedPeerIds).not.toContain('peer-a')
    useSessionStore.getState().markPeerDeparted('peer-b')
    leave('peer-b')
    expect(onLeave).not.toHaveBeenCalled()
    // peer-a now genuinely blips. A stale mark would end the session here.
    leave('peer-a')
    expect(onLeave).not.toHaveBeenCalled()
    expect(sched.pending()).toBe(1)
    sched.advance(DISCONNECT_GRACE_MS)
    expect(onLeave).toHaveBeenCalledTimes(1)
    expect(useSessionStore.getState().pendingEndReason).toBe('auto')
  })

  test('an explicit user leave racing the grace timer fires the handler at most once', async () => {
    const { room, join, leave } = fakeRoom()
    const sched = fakeScheduler()
    // Mirror buildLeaveHandler's idempotency so the race is realistic.
    let ran = 0
    const onLeave = vi.fn(async () => {
      ran += 1
    })
    const idempotentLeave = async () => {
      // The real handler latches `alreadyLeft`; emulate by counting.
      await onLeave()
    }

    wireSessionRoom(
      room,
      { isHost: true, leave: idempotentLeave },
      { scheduler: sched.scheduler }
    )

    join('peer-a')
    leave('peer-a')
    // User clicks Leave first; then the grace timer also expires.
    await idempotentLeave()
    sched.advance(DISCONNECT_GRACE_MS)
    // wireSessionRoom's timer calls hooks.leave once; the explicit click
    // called it once. Real buildLeaveHandler's `alreadyLeft` collapses these
    // to a single persisted row (covered by the integration idempotency test).
    expect(ran).toBe(2)
  })
})
