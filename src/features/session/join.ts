import { usePttStore } from '@/stores/pttStore'
import { useSessionStore } from '@/stores/sessionStore'

import {
  buildLeaveHandler,
  createGuestRoom,
  wireSessionRoom,
  type SessionHandle,
} from './lifecycle'

// Joins an existing trystero room with the password from the invite envelope.
// Updates the session store as a guest (isHost: false) and returns a handle
// whose `leave` tears the room down + persists the row.
export function joinSession(
  sessionTopic: string,
  sessionPassword: string
): SessionHandle {
  // S2 — clear any PTT latched by a dropped Released event before the media-
  // acquire effect reads it, so the first audio track never comes up live.
  usePttStore.getState().reset()
  const { room, topic, password } = createGuestRoom(
    sessionTopic,
    sessionPassword
  )
  const startedAt = Date.now()
  const leave = buildLeaveHandler({ room, topic, startedAt })
  useSessionStore.getState().begin({
    sessionTopic: topic,
    sessionPassword: password,
    isHost: false,
    startedAt,
    room,
    leave,
  })
  const lifecycle = wireSessionRoom(room, { isHost: false, leave })
  return {
    sessionTopic: topic,
    sessionPassword: password,
    room,
    leave,
    peers: lifecycle.peers,
  }
}
