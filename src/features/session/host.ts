import { usePttStore } from '@/stores/pttStore'
import { useIdentityStore } from '@/stores/identityStore'
import { useSessionStore, type SessionStore } from '@/stores/sessionStore'

import {
  buildLeaveHandler,
  beginSessionDiagnostics,
  createHostRoom,
  wireSessionRoom,
  type SessionHandle,
} from './lifecycle'

// Generates a session_id + session_password, derives the session_topic per
// ARCHITECTURE.md §4, joins the trystero room, registers the session in the
// session store so `inviteToCurrentSession` and `SessionView` can pick it up,
// and returns a handle whose `leave` tears the room down + persists the row.
export type HostSessionOptions = {
  store?: SessionStore
}

export function hostSession(options?: HostSessionOptions): SessionHandle {
  const store = options?.store ?? useSessionStore
  // S2 — clear any PTT latched by a dropped Released event before the media-
  // acquire effect reads it, so the first audio track never comes up live.
  usePttStore.getState().reset()
  const { room, topic, password } = createHostRoom()
  beginSessionDiagnostics(topic, 'host')
  const startedAt = Date.now()
  const startedAtMono = performance.now()
  const identity = useIdentityStore.getState().identity
  const leave = buildLeaveHandler({
    room,
    topic,
    startedAt,
    startedAtMono,
    localEdPubkey: identity?.ed_pubkey_hex ?? null,
    localDisplayName: identity?.display_name.trim() || null,
    continuesFocus: false,
    store,
  })
  store.getState().begin({
    sessionTopic: topic,
    sessionPassword: password,
    isHost: true,
    isRejoin: false,
    startedAt,
    startedAtMono,
    room,
    leave,
  })
  const lifecycle = wireSessionRoom(room, { isHost: true, leave }, store)
  return {
    sessionTopic: topic,
    sessionPassword: password,
    room,
    leave,
    peers: lifecycle.peers,
  }
}
