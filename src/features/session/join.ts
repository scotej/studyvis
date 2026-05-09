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
