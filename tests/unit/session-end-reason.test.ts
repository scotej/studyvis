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

  test('reset clears the reason', () => {
    begin()
    useSessionStore.getState().markEnded()
    useSessionStore.getState().reset()
    expect(useSessionStore.getState().endedBy).toBeNull()
  })
})
