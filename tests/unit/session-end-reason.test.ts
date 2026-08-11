import { beforeEach, describe, expect, test } from 'vitest'

import type { TopicRoom } from '@/lib/trystero'
import { useSessionStore } from '@/stores/sessionStore'

// #210 — local lifetime has two end reasons only. A deliberate local Leave is
// eligible for a short Rejoin opportunity; forced rejection is not. Remote
// peers leaving is no longer an end reason at all.

function begin(isHost = false): void {
  useSessionStore.getState().begin({
    sessionTopic: 'topic',
    sessionPassword: 'pw',
    isHost,
    startedAt: 1_700_000_000_000,
    room: {} as TopicRoom,
    leave: async () => {},
  })
}

describe('local session end reason', () => {
  beforeEach(() => {
    useSessionStore.getState().reset()
  })

  test('a plain markEnded records a user-initiated end', () => {
    begin()
    useSessionStore.getState().markEnded()
    expect(useSessionStore.getState().endedBy).toBe('user')
  })

  test('a forced peer reason is consumed and cannot be overwritten by teardown', () => {
    begin()
    useSessionStore.getState().setPendingEndReason('peer')
    useSessionStore.getState().setPendingEndReason('user')
    useSessionStore.getState().markEnded()

    const state = useSessionStore.getState()
    expect(state.endedBy).toBe('peer')
    expect(state.pendingEndReason).toBeNull()
  })

  test('a local Leave that wins the race remains user-attributed', () => {
    begin()
    useSessionStore.getState().setPendingEndReason('user')
    useSessionStore.getState().setPendingEndReason('peer')
    useSessionStore.getState().markEnded()
    expect(useSessionStore.getState().endedBy).toBe('user')
  })

  test('a user ending can rejoin before, but not at, its deadline', () => {
    begin()
    useSessionStore.getState().setPendingEndReason('user')
    useSessionStore.getState().setRejoinDeadline(20_000)
    useSessionStore.getState().markEnded()

    expect(useSessionStore.getState().getRejoinRequest(19_999)).toEqual({
      sessionTopic: 'topic',
      sessionPassword: 'pw',
      isHost: false,
    })
    expect(useSessionStore.getState().getRejoinRequest(20_000)).toBeNull()
  })

  test('a peer-forced ending is never rejoinable even with a deadline', () => {
    begin()
    useSessionStore.getState().setPendingEndReason('peer')
    useSessionStore.getState().setRejoinDeadline(20_000)
    useSessionStore.getState().markEnded()

    expect(useSessionStore.getState().getRejoinRequest(1)).toBeNull()
  })

  test('an eligible Rejoin preserves the prior host role', () => {
    begin(true)
    useSessionStore.getState().setRejoinDeadline(20_000)
    useSessionStore.getState().markEnded()
    expect(useSessionStore.getState().getRejoinRequest(19_999)?.isHost).toBe(
      true
    )
  })

  test('begin and reset clear stale reason and deadline state', () => {
    begin()
    useSessionStore.getState().setPendingEndReason('peer')
    useSessionStore.getState().setRejoinDeadline(20_000)
    useSessionStore.getState().markEnded()

    begin()
    expect(useSessionStore.getState().endedBy).toBeNull()
    expect(useSessionStore.getState().pendingEndReason).toBeNull()
    expect(useSessionStore.getState().rejoinDeadline).toBeNull()

    useSessionStore.getState().markEnded()
    useSessionStore.getState().reset()
    expect(useSessionStore.getState().status).toBe('idle')
    expect(useSessionStore.getState().endedBy).toBeNull()
    expect(useSessionStore.getState().rejoinDeadline).toBeNull()
  })
})
