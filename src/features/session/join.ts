import { usePttStore } from '@/stores/pttStore'
import { useIdentityStore } from '@/stores/identityStore'
import {
  useSessionStore,
  type GuestAdmissionSnapshot,
  type SessionStore,
} from '@/stores/sessionStore'

import {
  buildLeaveHandler,
  beginSessionDiagnostics,
  createGuestRoom,
  wireSessionRoom,
  type SessionHandle,
} from './lifecycle'
import { rememberActiveSession } from './recovery'

export type JoinSessionOptions = {
  store?: SessionStore
  // The signed inviter from the accepted inbox envelope. Guests bind original
  // admission authority to this identity instead of trusting a racing peer.
  expectedAuthorityEdPubkeyHex?: string | null
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
  isHost: boolean,
  options?: JoinSessionOptions
): SessionHandle {
  return joinExistingSession(
    sessionTopic,
    sessionPassword,
    isHost,
    true,
    options
  )
}

function joinExistingSession(
  sessionTopic: string,
  sessionPassword: string,
  isHost: boolean,
  isRejoin: boolean,
  options?: JoinSessionOptions
): SessionHandle {
  const store = options?.store ?? useSessionStore
  // S2 — clear any PTT latched by a dropped Released event before the media-
  // acquire effect reads it, so the first audio track never comes up live.
  usePttStore.getState().reset()
  // A guest can accept a fresh invite to the same still-live room from the
  // post-session Report. That is another stint of the existing logical
  // session just like its explicit Rejoin button; preserve focus state before
  // `begin()` replaces the ended store snapshot.
  const previousSession = store.getState()
  const continuesEndedSession =
    previousSession.status === 'ended' &&
    previousSession.sessionTopic === sessionTopic
  const continuesFocus = isRejoin || continuesEndedSession
  // A host keeps the incumbent mesh it observed before Leave. Its same-ID
  // reconnect reserves those slots briefly so a delayed invite cannot arrive
  // first and make the returning host reject a valid survivor.
  const reservedReconnectPeerIds =
    isHost &&
    isRejoin &&
    previousSession.status === 'ended' &&
    previousSession.sessionTopic === sessionTopic
      ? previousSession.reservedReconnectPeerIds
      : []
  const { room, topic, password } = createGuestRoom(
    sessionTopic,
    sessionPassword
  )
  beginSessionDiagnostics(topic, isHost ? 'host' : 'guest')
  const startedAt = Date.now()
  const startedAtMono = performance.now()
  const identity = useIdentityStore.getState().identity
  let stopPeerAuthenticationWatch: (() => void) | null = null
  let lifecycle: ReturnType<typeof wireSessionRoom> | null = null
  let teardownCommitted = false
  let pendingFrozenGuestAdmission: GuestAdmissionSnapshot | null = null
  const leaveBase = buildLeaveHandler({
    room,
    topic,
    startedAt,
    startedAtMono,
    localEdPubkey: identity?.ed_pubkey_hex ?? null,
    localDisplayName: identity?.display_name.trim() || null,
    continuesFocus,
    store,
    onTeardownCommitted: () => {
      teardownCommitted = true
      // A pending-invite observer is scoped to this room attempt. It must
      // never consume an old credential in a later session after teardown.
      try {
        stopPeerAuthenticationWatch?.()
        stopPeerAuthenticationWatch = null
        try {
          store.getState().setFrozenGuestAdmission(pendingFrozenGuestAdmission)
        } catch {
          // buildLeaveHandler owns the authoritative committed teardown and
          // continues even if an optional store subscriber is misbehaving.
        }
      } finally {
        lifecycle?.dispose()
      }
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
    leaveAttempt = attempt
    teardownCommitted = false
    try {
      // Capture before the inner leave clears Trystero's peer state, but do
      // not write/dispose until its preflight declares teardown committed.
      pendingFrozenGuestAdmission = isHost
        ? null
        : (lifecycle?.getFrozenGuestAdmission() ?? null)
    } catch (err) {
      if (leaveAttempt === attempt) leaveAttempt = null
      rejectAttempt(err)
      return attempt
    }
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
    isHost,
    expectedAuthorityEdPubkeyHex: options?.expectedAuthorityEdPubkeyHex,
    isRejoin: continuesFocus,
    startedAt,
    startedAtMono,
    room,
    leave,
    authenticateAuthority: (peerId, edPubkeyHex) =>
      lifecycle?.authenticateAuthority(peerId, edPubkeyHex),
  })
  lifecycle = wireSessionRoom(
    room,
    {
      isHost,
      expectedAuthorityEdPubkeyHex: options?.expectedAuthorityEdPubkeyHex,
      reservedReconnectPeerIds,
      frozenGuestAdmission:
        !isHost &&
        isRejoin &&
        previousSession.status === 'ended' &&
        previousSession.sessionTopic === sessionTopic
          ? previousSession.frozenGuestAdmission
          : null,
      leave,
    },
    store
  )
  // #225 — after begin(), so the declared topic the store just resolved is
  // the one a launch-time recovery prompt shows.
  rememberActiveSession({
    identity,
    sessionTopic: topic,
    sessionPassword: password,
    isHost,
    expectedAuthorityEdPubkeyHex: options?.expectedAuthorityEdPubkeyHex ?? null,
    declaredStudyTopic: store.getState().declaredStudyTopic,
    startedAt,
  })
  const onPeerAuthenticated = options?.onPeerAuthenticated
  if (onPeerAuthenticated) {
    const notifiedPeerIdentities = new Set<string>()
    stopPeerAuthenticationWatch = store.subscribe((state) => {
      // setPeerHello is reached only after SessionView validates the hello
      // signature and confirms the room lifecycle admitted the peer. Notify
      // once per newly authenticated peer binding, rather than on arbitrary
      // session-store updates.
      if (state.sessionTopic !== topic) return
      for (const [peerId, peer] of Object.entries(state.peers)) {
        const edPubkeyHex = peer.edPubkeyHex
        if (!edPubkeyHex) continue
        // SessionView feeds its one existing, signature-validated hello
        // directly into lifecycle authority authentication. This observer is
        // deliberately post-admission only: its purpose is pending-invite
        // consumption, never authority transfer or provisional history.
        if (
          onPeerAuthenticated &&
          lifecycle?.peers().includes(peerId) &&
          !notifiedPeerIdentities.has(`${peerId}:${edPubkeyHex}`)
        ) {
          notifiedPeerIdentities.add(`${peerId}:${edPubkeyHex}`)
          onPeerAuthenticated(edPubkeyHex)
        }
      }
    })
  }
  return {
    sessionTopic: topic,
    sessionPassword: password,
    room,
    leave,
    peers: () => lifecycle?.peers() ?? [],
  }
}
