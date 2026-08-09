import { usePttStore } from '@/stores/pttStore'
import { useIdentityStore } from '@/stores/identityStore'
import { useSessionStore } from '@/stores/sessionStore'

import {
  buildLeaveHandler,
  beginSessionDiagnostics,
  createGuestRoom,
  wireSessionRoom,
  type SessionHandle,
} from './lifecycle'

export type JoinSessionOptions = {
  // Called only after SessionView has verified a signed hello from a peer that
  // the room lifecycle admitted. This is deliberately later than `joinRoom`:
  // creating a local Trystero room says nothing about remote availability or
  // identity.
  onPeerAuthenticated?: (edPubkeyHex: string) => void
}

// Joins an existing trystero room with the password from the invite envelope.
// Updates the session store as a guest and returns a handle whose `leave`
// tears the room down + persists the row.
export function joinSession(
  sessionTopic: string,
  sessionPassword: string,
  options?: JoinSessionOptions
): SessionHandle {
  return joinExistingSession(
    sessionTopic,
    sessionPassword,
    false,
    false,
    options
  )
}

// Re-enter the same room while preserving the role held by the prior stint.
// The original host must remain responsible for participant-cap enforcement
// and retain the ability to invite friends after an accidental Leave.
export function rejoinSession(
  sessionTopic: string,
  sessionPassword: string,
  isHost: boolean
): SessionHandle {
  return joinExistingSession(sessionTopic, sessionPassword, isHost, true)
}

function joinExistingSession(
  sessionTopic: string,
  sessionPassword: string,
  isHost: boolean,
  isRejoin: boolean,
  options?: JoinSessionOptions
): SessionHandle {
  // S2 — clear any PTT latched by a dropped Released event before the media-
  // acquire effect reads it, so the first audio track never comes up live.
  usePttStore.getState().reset()
  // A guest can accept a fresh invite to the same still-live room from the
  // post-session Report. That is another stint of the existing logical
  // session just like its explicit Rejoin button; preserve focus state before
  // `begin()` replaces the ended store snapshot.
  const previous = useSessionStore.getState()
  const continuesEndedSession =
    previous.status === 'ended' && previous.sessionTopic === sessionTopic
  const continuesFocus = isRejoin || continuesEndedSession
  const { room, topic, password } = createGuestRoom(
    sessionTopic,
    sessionPassword
  )
  beginSessionDiagnostics(topic, 'guest')
  const startedAt = Date.now()
  const startedAtMono = performance.now()
  const identity = useIdentityStore.getState().identity
  const leaveBase = buildLeaveHandler({
    room,
    topic,
    startedAt,
    startedAtMono,
    localEdPubkey: identity?.ed_pubkey_hex ?? null,
    localDisplayName: identity?.display_name.trim() || null,
    continuesFocus,
  })
  let stopPeerAuthenticationWatch: (() => void) | null = null
  const leave = async (): Promise<void> => {
    // A pending-invite observer is scoped to this room attempt. It must never
    // consume an old credential in a later session after this attempt ends.
    stopPeerAuthenticationWatch?.()
    stopPeerAuthenticationWatch = null
    await leaveBase()
  }
  useSessionStore.getState().begin({
    sessionTopic: topic,
    sessionPassword: password,
    isHost,
    isRejoin: continuesFocus,
    startedAt,
    startedAtMono,
    room,
    leave,
  })
  const onPeerAuthenticated = options?.onPeerAuthenticated
  if (onPeerAuthenticated) {
    stopPeerAuthenticationWatch = useSessionStore.subscribe(
      (state, previous) => {
        // setPeerHello is reached only after SessionView validates the hello
        // signature and confirms the room lifecycle admitted the peer. Notify
        // once per newly authenticated peer binding, rather than on arbitrary
        // session-store updates.
        if (state.sessionTopic !== topic) return
        for (const [peerId, peer] of Object.entries(state.peers)) {
          const edPubkeyHex = peer.edPubkeyHex
          if (
            !edPubkeyHex ||
            previous.peers[peerId]?.edPubkeyHex === edPubkeyHex
          ) {
            continue
          }
          onPeerAuthenticated(edPubkeyHex)
        }
      }
    )
  }
  const lifecycle = wireSessionRoom(room, { isHost, leave })
  return {
    sessionTopic: topic,
    sessionPassword: password,
    room,
    leave,
    peers: lifecycle.peers,
  }
}
