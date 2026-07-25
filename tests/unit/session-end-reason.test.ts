import { beforeEach, describe, expect, test } from 'vitest'

import type { TopicRoom } from '@/lib/trystero'
import { useSessionStore } from '@/stores/sessionStore'

// #47 B3 — markEnded records WHY the session ended so the Report can offer
// Rejoin exactly for the S1 grace-window auto-end (the one case where the
// room may still be live without us).

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

  test('reset clears the reason', () => {
    begin()
    useSessionStore.getState().markEnded()
    useSessionStore.getState().reset()
    expect(useSessionStore.getState().endedBy).toBeNull()
  })
})
