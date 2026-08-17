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
import { rememberActiveSession } from './recovery'

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
  let lifecycle: ReturnType<typeof wireSessionRoom> | null = null
  let teardownCommitted = false
  const leaveBase = buildLeaveHandler({
    room,
    topic,
    startedAt,
    startedAtMono,
    localEdPubkey: identity?.ed_pubkey_hex ?? null,
    localDisplayName: identity?.display_name.trim() || null,
    continuesFocus: false,
    store,
    onTeardownCommitted: () => {
      teardownCommitted = true
      lifecycle?.dispose()
    },
  })
  let leaveAttempt: Promise<void> | null = null
  const leave = (): Promise<void> => {
    if (leaveAttempt) return leaveAttempt
    let resolveAttempt!: () => void
    let rejectAttempt!: (reason: unknown) => void
    const attempt = new Promise<void>((resolve, reject) => {
      resolveAttempt = resolve
      rejectAttempt = reject
    })
    // Cache before any synchronous getter/store work. A re-entrant observer
    // triggered during preflight must receive this exact attempt, not launch a
    // second room teardown.
    leaveAttempt = attempt
    teardownCommitted = false
    let inner: Promise<void>
    try {
      inner = leaveBase()
    } catch (err) {
      if (leaveAttempt === attempt) leaveAttempt = null
      rejectAttempt(err)
      return attempt
    }
    void inner.then(
      () => resolveAttempt(),
      (err) => {
        if (!teardownCommitted && leaveAttempt === attempt) leaveAttempt = null
        rejectAttempt(err)
      }
    )
    return attempt
  }
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
  lifecycle = wireSessionRoom(room, { isHost: true, leave }, store)
  // #225 — after begin(), so the declared topic the store just resolved is
  // the one a launch-time recovery prompt shows.
  rememberActiveSession({
    identity,
    sessionTopic: topic,
    sessionPassword: password,
    isHost: true,
    expectedAuthorityEdPubkeyHex: null,
    declaredStudyTopic: store.getState().declaredStudyTopic,
    startedAt,
  })
  return {
    sessionTopic: topic,
    sessionPassword: password,
    room,
    leave,
    peers: () => lifecycle?.peers() ?? [],
  }
}
