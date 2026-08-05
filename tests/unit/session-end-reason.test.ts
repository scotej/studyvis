import { beforeEach, describe, expect, test } from 'vitest'

import type { TopicRoom } from '@/lib/trystero'
import { useSessionStore } from '@/stores/sessionStore'

// #47 B3 / #190 — markEnded records why the session ended and the store
// rejects stale report actions once the teardown-time rejoin deadline passes.

function begin(): void {
  useSessionStore.getState().begin({
    sessionTopic: 'topic',
    sessionPassword: 'pw',
    isHost: false,
    startedAt: 1_700_000_000_000,
    room: {} as TopicRoom,
    leave: async () => {},
  })
}

describe('session end reason (#47 B3)', () => {
  beforeEach(() => {
    useSessionStore.getState().reset()
  })

  test('a plain markEnded records a user-initiated end', () => {
    begin()
    useSessionStore.getState().markEnded()
    expect(useSessionStore.getState().endedBy).toBe('user')
  })

  test('a staged auto reason is consumed by markEnded', () => {
    begin()
    useSessionStore.getState().setPendingEndReason('auto')
    useSessionStore.getState().markEnded()
    const s = useSessionStore.getState()
    expect(s.endedBy).toBe('auto')
    expect(s.pendingEndReason).toBeNull()
  })

  // Every peer broadcast a signed 'left' before tearing down, so the room is
  // provably empty: the reason must be distinguishable from 'auto', which is
  // the only one Home offers Rejoin for.
  test("a staged peer-departure reason survives the leave handler's own staging", () => {
    begin()
    useSessionStore.getState().setPendingEndReason('peer')
    useSessionStore.getState().setPendingEndReason('user')
    useSessionStore.getState().markEnded()
    expect(useSessionStore.getState().endedBy).toBe('peer')
    expect(useSessionStore.getState().endedBy).not.toBe('auto')
  })

  test('a user leave that raced the grace timer stays user-attributed', () => {
    begin()
    useSessionStore.getState().markEnded()
    // The timer fires afterwards and stages 'auto', but the session already
    // ended; the stale stage must not rewrite history…
    useSessionStore.getState().setPendingEndReason('auto')
    useSessionStore.getState().markEnded()
    expect(useSessionStore.getState().endedBy).toBe('user')
    // …and the next session clears the stale stage.
    begin()
    expect(useSessionStore.getState().pendingEndReason).toBeNull()
    expect(useSessionStore.getState().endedBy).toBeNull()
  })

  // The mid-teardown interleaving: buildLeaveHandler stages 'user'
  // synchronously, then awaits IPC round-trips; if the grace deadline lands
  // inside that window its 'auto' staging must NOT overwrite the deliberate
  // Leave (first writer wins).
  test('a grace expiry firing during a user leave in flight cannot rewrite the reason', () => {
    begin()
    useSessionStore.getState().setPendingEndReason('user')
    useSessionStore.getState().setPendingEndReason('auto')
    useSessionStore.getState().markEnded()
    expect(useSessionStore.getState().endedBy).toBe('user')
  })

  // And the inverse ordering keeps the auto path intact: the grace timer
  // stages 'auto' before invoking the handler, whose own 'user' staging must
  // then no-op.
  test('the auto path survives the handler staging after the timer', () => {
    begin()
    useSessionStore.getState().setPendingEndReason('auto')
    useSessionStore.getState().setPendingEndReason('user')
    useSessionStore.getState().markEnded()
    expect(useSessionStore.getState().endedBy).toBe('auto')
  })

  test.each(['auto', 'user'] as const)(
    'rejects a late rejoin request after a %s ending',
    (reason) => {
      begin()
      useSessionStore.getState().setPendingEndReason(reason)
      useSessionStore.getState().setRejoinDeadline(20_000)
      useSessionStore.getState().markEnded()

      expect(useSessionStore.getState().getRejoinRequest(19_999)).toEqual({
        sessionTopic: 'topic',
        sessionPassword: 'pw',
        isHost: false,
      })
      expect(useSessionStore.getState().getRejoinRequest(20_000)).toBeNull()
    }
  )

  test('preserves the prior role in an eligible rejoin request', () => {
    useSessionStore.getState().begin({
      sessionTopic: 'topic',
      sessionPassword: 'pw',
      isHost: true,
      startedAt: 1_700_000_000_000,
      room: {} as TopicRoom,
      leave: async () => {},
    })
    useSessionStore.getState().setRejoinDeadline(20_000)
    useSessionStore.getState().markEnded()
    expect(useSessionStore.getState().getRejoinRequest(19_999)?.isHost).toBe(
      true
    )
  })

  test('reset clears the reason', () => {
    begin()
    useSessionStore.getState().markEnded()
    useSessionStore.getState().reset()
    expect(useSessionStore.getState().endedBy).toBeNull()
  })
})
