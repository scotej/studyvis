import { usePttStore } from '@/stores/pttStore'
import { useSessionStore } from '@/stores/sessionStore'

import {
  buildLeaveHandler,
  beginSessionDiagnostics,
  createGuestRoom,
  wireSessionRoom,
  type SessionHandle,
} from './lifecycle'

// Joins an existing trystero room with the password from the invite envelope.
// Updates the session store as a guest and returns a handle whose `leave`
// tears the room down + persists the row.
export function joinSession(
  sessionTopic: string,
  sessionPassword: string
): SessionHandle {
  return joinExistingSession(sessionTopic, sessionPassword, false)
}

// Re-enter the same room while preserving the role held by the prior stint.
// The original host must remain responsible for participant-cap enforcement
// and retain the ability to invite friends after an accidental Leave.
export function rejoinSession(
  sessionTopic: string,
  sessionPassword: string,
  isHost: boolean
): SessionHandle {
  return joinExistingSession(sessionTopic, sessionPassword, isHost)
}

function joinExistingSession(
  sessionTopic: string,
  sessionPassword: string,
  isHost: boolean
): SessionHandle {
  // S2 — clear any PTT latched by a dropped Released event before the media-
  // acquire effect reads it, so the first audio track never comes up live.
  usePttStore.getState().reset()
  const { room, topic, password } = createGuestRoom(
    sessionTopic,
    sessionPassword
  )
  beginSessionDiagnostics(topic, 'guest')
  const startedAt = Date.now()
  const startedAtMono = performance.now()
  const leave = buildLeaveHandler({ room, topic, startedAt, startedAtMono })
  useSessionStore.getState().begin({
    sessionTopic: topic,
    sessionPassword: password,
    isHost,
    startedAt,
    startedAtMono,
    room,
    leave,
  })
  const lifecycle = wireSessionRoom(room, { isHost, leave })
  return {
    sessionTopic: topic,
    sessionPassword: password,
    room,
    leave,
    peers: lifecycle.peers,
  }
}
