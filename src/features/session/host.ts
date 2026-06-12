import { usePttStore } from '@/stores/pttStore'
import { useSessionStore } from '@/stores/sessionStore'

import {
  buildLeaveHandler,
  createHostRoom,
  wireSessionRoom,
  type SessionHandle,
} from './lifecycle'

// Generates a session_id + session_password, derives the session_topic per
// ARCHITECTURE.md §4, joins the trystero room, registers the session in the
// session store so `inviteToCurrentSession` and `SessionView` can pick it up,
// and returns a handle whose `leave` tears the room down + persists the row.
export function hostSession(): SessionHandle {
  // S2 — clear any PTT latched by a dropped Released event before the media-
  // acquire effect reads it, so the first audio track never comes up live.
  usePttStore.getState().reset()
  const { room, topic, password } = createHostRoom()
  const startedAt = Date.now()
  const leave = buildLeaveHandler({ room, topic, startedAt })
  useSessionStore.getState().begin({
    sessionTopic: topic,
    sessionPassword: password,
    isHost: true,
    startedAt,
    room,
    leave,
  })
  const lifecycle = wireSessionRoom(room, { isHost: true, leave })
  return {
    sessionTopic: topic,
    sessionPassword: password,
    room,
    leave,
    peers: lifecycle.peers,
  }
}
