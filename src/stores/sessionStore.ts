// Zustand store for the live study-session lifecycle: status, the peers map,
// the declared-topic trio (see the three per-field comments below — they have
// distinct lifetimes), and authenticated peer-presence intervals. Mutated by
// `features/session/*`
// (host/join/lifecycle/hello); read by SessionView, the AI sample loop, and
// the leave handler.

import { create, type StateCreator } from 'zustand'

import type { TopicRoom } from '@/lib/trystero'

export type SessionStatus = 'idle' | 'active' | 'ended'

// Why the local session ended. Remote membership changes never end it:
// 'user' is an explicit local Leave and may be rejoinable; 'peer' is an
// externally forced local termination such as admission rejection.
export type SessionEndReason = 'user' | 'peer'

export type SessionRejoinRequest = {
  sessionTopic: string
  sessionPassword: string
  isHost: boolean
  expectedAuthorityEdPubkeyHex: string | null
  // Transport IDs captured before the local room tears down. A same-ID host
  // rejoin keeps these incumbent slots reserved briefly, so a delayed fifth
  // cannot arrive first and consume one of the original mesh's places.
  reservedReconnectPeerIds: string[]
  frozenGuestAdmission: GuestAdmissionSnapshot | null
}

// Captured only from a locally authenticated, host-loss-frozen lifecycle.
// It lets a guest rejoin surviving incumbents without giving a new peer any
// opportunity to invent authority while the original host is gone.
export type GuestAdmissionSnapshot = {
  authorityPeerId: string
  authorityEdPubkeyHex: string
  admittedPeerIds: string[]
}

// Mirrors the validated payload shape returned by the V1-P9 signed-hello
// handshake. Inlined here so the store does not import a feature module
// (keeps stores → lib + zustand only, matching friendsStore / pttStore).
export type PeerHello = {
  ed_pubkey_hex: string
  display_name: string
  joined_at: number
}

export type PeerSnapshot = {
  peerId: string
  hasStream: boolean
  ptt: boolean
  // #264 — the transport dropped without a clean departure and the lifecycle
  // is holding this tile open for a same-peerId reconnect. The identity
  // binding and presence interval are already closed (see peerTransportLost),
  // so every identity-gated consumer treats it as absent; only the grid still
  // shows it, labelled "Reconnecting…".
  reconnecting: boolean
  // Populated by the signed-hello handshake (V1-P9). Receivers gate audit-
  // event verification on this binding's presence; absent until hello arrives.
  edPubkeyHex: string | null
  displayName: string | null
  joinedAt: number | null
}

export type PeerPresenceClock = {
  wallMs: number
  monoMs: number
}

export type PeerPresence = {
  accumulatedMs: number
  activeSinceWall: number | null
  activeSinceMono: number | null
  lastEndedAt: number | null
}

export type PeerPresenceClose = {
  edPubkeyHex: string
  endedAt: number
}

export type FinalizedPeerPresence = {
  durationsMs: Record<string, number>
  lastStudiedAt: Record<string, number>
}

export type SessionInit = {
  sessionTopic: string
  sessionPassword: string
  isHost: boolean
  // For guests, the signed inbox inviter that is allowed to become the
  // original admission authority. Retained through a local Leave/Rejoin.
  expectedAuthorityEdPubkeyHex?: string | null
  startedAt: number
  // performance.now() taken alongside startedAt. Optional so non-production
  // callers (tests, stories) can omit it; consumers fall back to wall clock.
  startedAtMono?: number
  // True only when this is another stint in the still-open logical session.
  // SessionView keeps the focus score/tallies continuous in that case.
  isRejoin?: boolean
  room: TopicRoom
  leave: () => Promise<void>
  // Bound by join.ts after it creates the room lifecycle. SessionView calls
  // this only for an already signature-validated inviter hello that is not
  // yet admitted, keeping that provisional identity out of durable history.
  authenticateAuthority?: (peerId: string, edPubkeyHex: string) => void
}

// V2-P7 default until V2-P9 ships the required session-start topic input.
// Lives at module scope so SessionView + tests can reference the same
// literal when resetting the field.
export const DEFAULT_DECLARED_STUDY_TOPIC = 'Studying'

export type SessionState = {
  status: SessionStatus
  // See SessionEndReason. Set by markEnded, cleared by begin/reset.
  endedBy: SessionEndReason | null
  // One-shot reason staged before the leave handler runs; markEnded consumes
  // it and defaults to 'user' when nothing was staged. FIRST writer wins so a
  // local Leave and a simultaneous session-full rejection cannot rewrite one
  // another while teardown awaits IPC.
  pendingEndReason: SessionEndReason | null
  // Absolute wall-clock deadline captured when teardown begins. It starts
  // before room.leave(), persistence, and report loading, so slow cleanup
  // cannot accidentally extend this local user's Rejoin opportunity.
  rejoinDeadline: number | null
  reservedReconnectPeerIds: string[]
  frozenGuestAdmission: GuestAdmissionSnapshot | null
  sessionTopic: string | null
  sessionPassword: string | null
  isHost: boolean
  expectedAuthorityEdPubkeyHex: string | null
  isRejoin: boolean
  startedAt: number | null
  // Monotonic origin for the same session start, so the live elapsed clock
  // (and the persisted total) can ignore time the machine spent asleep.
  startedAtMono: number | null
  hadAnyPeer: boolean
  peers: Record<string, PeerSnapshot>
  room: TopicRoom | null
  leave: (() => Promise<void>) | null
  authenticateAuthority: ((peerId: string, edPubkeyHex: string) => void) | null
  // User's declared study topic, consumed by the AI sample loop (V2-P5)
  // and the Ctrl+] AI dialog (V2-P7). Defaults to
  // DEFAULT_DECLARED_STUDY_TOPIC until V2-P9's session-start prompt
  // requires the user to set it. `setDeclaredStudyTopic` is the only
  // mutator; the dialog window emits a `topic_change` event that
  // SessionView routes here so the live sample loop sees the next value
  // on its next tick.
  declaredStudyTopic: string
  // The topic value at session START — set once in `begin()` and never
  // mutated. V2-P8's report generator persists this to
  // `sessions.declared_topic` so the report's topic timeline can render
  // "started studying X" before walking the `topic_change` events.
  // Without this, reconstructing the starting topic from the first
  // `topic_change.previous_topic` would fail in the no-topic-change case.
  initialDeclaredTopic: string
  // V2-P9 one-shot hand-off for the required session-start topic prompt.
  // Set while `status === 'idle'` (before any peer can see the session),
  // consumed and cleared by `begin()`. When non-empty it seeds BOTH
  // `initialDeclaredTopic` (→ sessions.declared_topic) and the mutable
  // `declaredStudyTopic` (the sample loop's live value); when null `begin()`
  // falls back to DEFAULT_DECLARED_STUDY_TOPIC (the AI-off path never sets
  // it). Kept distinct from `declaredStudyTopic` so the Ctrl+] dialog's
  // mid-session `topic_change` path stays independent.
  pendingInitialTopic: string | null
  // Every distinct ed_pubkey_hex observed via signed-hello during THIS
  // session, accumulated and never pruned by `peerLeft`. The leave handler
  // and `collectPeerPubkeys` use it for session membership/history even after
  // the local user has continued studying solo. Cleared by begin/reset.
  seenPeerEdPubkeys: string[]
  // Cumulative ed_pubkey_hex → display_name observed via signed-hello this
  // session, never pruned by peerLeft (mirrors seenPeerEdPubkeys). The audit
  // panel reads this so a peer who leaves a still-running 3+ person session
  // keeps their name on past rows instead of falling back to a hex fragment.
  seenPeerNames: Record<string, string>
  // Authenticated overlap per Ed25519 identity. Intervals start only once a
  // verified hello binds an admitted transport peer. A duplicate connection
  // for the same identity shares one interval, so it cannot double-count.
  peerPresence: Record<string, PeerPresence>
  begin: (init: SessionInit) => void
  setPendingInitialTopic: (topic: string | null) => void
  setDeclaredStudyTopic: (next: string) => void
  peerJoined: (peerId: string) => void
  peerLeft: (
    peerId: string,
    clock?: PeerPresenceClock
  ) => PeerPresenceClose | null
  // #264 — an unclean transport loss. Closes the authenticated overlap
  // interval at `clock` exactly as peerLeft does (so a session ended during
  // the grace window can never over-count), but keeps a name-only stub in
  // `peers` so the grid can show "Reconnecting…" instead of the friend
  // vanishing. A same-peerId rejoin rebinds through the normal
  // peerJoined + signed-hello path and opens a fresh interval.
  peerTransportLost: (
    peerId: string,
    clock?: PeerPresenceClock
  ) => PeerPresenceClose | null
  // Drops a stub left by peerTransportLost once its grace window expires.
  // Never removes a peer that reconnected in the meantime.
  peerReconnectExpired: (peerId: string) => void
  setPeerStream: (peerId: string, hasStream: boolean) => void
  setPeerPtt: (peerId: string, active: boolean) => void
  setPeerHello: (
    peerId: string,
    hello: PeerHello,
    clock?: PeerPresenceClock
  ) => void
  // Returns sorted (lex) JSON-array string of every ed_pubkey_hex we've
  // observed via signed-hello in this session. Used by the leave handler to
  // populate sessions.peer_pubkeys. NULL until at least one hello arrived.
  collectPeerPubkeys: () => string | null
  // Closes all still-active overlap intervals exactly once and returns a
  // persistence snapshot. New sessions always persist the resulting map,
  // including an empty object for a known-solo session.
  finalizePeerPresence: (clock?: PeerPresenceClock) => FinalizedPeerPresence
  setPendingEndReason: (reason: SessionEndReason) => void
  // Clears only the caller's own staged reason. The comparison preserves a
  // competing first writer (for example, a session-full rejection) while a
  // failed local Leave attempt is made retryable.
  clearPendingEndReason: (reason: SessionEndReason) => void
  setRejoinDeadline: (deadline: number | null) => void
  setReservedReconnectPeerIds: (peerIds: readonly string[]) => void
  setFrozenGuestAdmission: (snapshot: GuestAdmissionSnapshot | null) => void
  getRejoinRequest: (now?: number) => SessionRejoinRequest | null
  // Flip status to 'ended' so Home.tsx can mount the post-session Report
  // (V2-P8). The Report queries SQLite for the just-persisted sessions
  // row + audit_events; the in-memory peers / displayNames aren't
  // consulted, so markEnded carries no snapshot payload. Reset is driven
  // by the Report's Close button — there's no auto-timeout.
  markEnded: () => void
  reset: () => void
}

const INITIAL: Pick<
  SessionState,
  | 'status'
  | 'endedBy'
  | 'pendingEndReason'
  | 'rejoinDeadline'
  | 'reservedReconnectPeerIds'
  | 'frozenGuestAdmission'
  | 'sessionTopic'
  | 'sessionPassword'
  | 'isHost'
  | 'expectedAuthorityEdPubkeyHex'
  | 'isRejoin'
  | 'startedAt'
  | 'startedAtMono'
  | 'hadAnyPeer'
  | 'peers'
  | 'room'
  | 'leave'
  | 'authenticateAuthority'
  | 'declaredStudyTopic'
  | 'initialDeclaredTopic'
  | 'pendingInitialTopic'
  | 'seenPeerEdPubkeys'
  | 'seenPeerNames'
  | 'peerPresence'
> = {
  status: 'idle',
  endedBy: null,
  pendingEndReason: null,
  rejoinDeadline: null,
  reservedReconnectPeerIds: [],
  frozenGuestAdmission: null,
  sessionTopic: null,
  sessionPassword: null,
  isHost: false,
  expectedAuthorityEdPubkeyHex: null,
  isRejoin: false,
  startedAt: null,
  startedAtMono: null,
  hadAnyPeer: false,
  peers: {},
  room: null,
  leave: null,
  authenticateAuthority: null,
  declaredStudyTopic: DEFAULT_DECLARED_STUDY_TOPIC,
  initialDeclaredTopic: DEFAULT_DECLARED_STUDY_TOPIC,
  pendingInitialTopic: null,
  seenPeerEdPubkeys: [],
  seenPeerNames: {},
  peerPresence: {},
}

function currentPresenceClock(): PeerPresenceClock {
  return { wallMs: Date.now(), monoMs: performance.now() }
}

function overlapMs(
  presence: Pick<PeerPresence, 'activeSinceWall' | 'activeSinceMono'>,
  end: PeerPresenceClock
): number {
  if (presence.activeSinceWall === null || presence.activeSinceMono === null) {
    return 0
  }
  const wallMs = end.wallMs - presence.activeSinceWall
  const monoMs = end.monoMs - presence.activeSinceMono
  if (!Number.isFinite(wallMs) || !Number.isFinite(monoMs)) return 0
  return Math.max(0, Math.floor(Math.min(wallMs, monoMs)))
}

type SessionSet = Parameters<StateCreator<SessionState>>[0]

// Shared body of peerLeft / peerTransportLost. Both close the departing
// transport's authenticated overlap interval at `clock`; they differ only in
// what is left behind in `peers` — nothing, or the #264 name-only
// "Reconnecting…" stub. The identity binding is dropped either way, so the
// interval close, every identity-gated consumer, and a later signed hello all
// behave exactly as they did before the stub existed.
function departPeer(
  set: SessionSet,
  peerId: string,
  clock: PeerPresenceClock,
  retainAsReconnecting: boolean
): PeerPresenceClose | null {
  let closed: PeerPresenceClose | null = null
  set((s) => {
    const departing = s.peers[peerId]
    if (!departing) return s
    const peers = { ...s.peers }
    if (retainAsReconnecting) {
      peers[peerId] = {
        ...departing,
        hasStream: false,
        ptt: false,
        reconnecting: true,
        edPubkeyHex: null,
      }
    } else {
      delete peers[peerId]
    }
    const edPubkeyHex = departing.edPubkeyHex
    if (!edPubkeyHex) return { peers }

    const identityStillPresent = Object.values(peers).some(
      (peer) => peer.edPubkeyHex === edPubkeyHex
    )
    const presence = s.peerPresence[edPubkeyHex]
    if (
      identityStillPresent ||
      !presence ||
      presence.activeSinceWall === null ||
      presence.activeSinceMono === null
    ) {
      return { peers }
    }

    const accumulatedMs = presence.accumulatedMs + overlapMs(presence, clock)
    closed = { edPubkeyHex, endedAt: clock.wallMs }
    return {
      peers,
      peerPresence: {
        ...s.peerPresence,
        [edPubkeyHex]: {
          accumulatedMs,
          activeSinceWall: null,
          activeSinceMono: null,
          lastEndedAt: clock.wallMs,
        },
      },
    }
  })
  return closed
}

const sessionStateCreator: StateCreator<SessionState> = (set, get) => ({
  ...INITIAL,
  begin: (init) =>
    set((s) => {
      const declared = s.pendingInitialTopic?.trim()
      const topic =
        declared && declared.length > 0
          ? declared
          : DEFAULT_DECLARED_STUDY_TOPIC
      return {
        status: 'active',
        endedBy: null,
        pendingEndReason: null,
        rejoinDeadline: null,
        reservedReconnectPeerIds: [],
        frozenGuestAdmission: null,
        sessionTopic: init.sessionTopic,
        sessionPassword: init.sessionPassword,
        isHost: init.isHost,
        expectedAuthorityEdPubkeyHex:
          init.expectedAuthorityEdPubkeyHex?.toLowerCase() ?? null,
        isRejoin: init.isRejoin ?? false,
        startedAt: init.startedAt,
        startedAtMono: init.startedAtMono ?? null,
        hadAnyPeer: false,
        peers: {},
        room: init.room,
        leave: init.leave,
        authenticateAuthority: init.authenticateAuthority ?? null,
        declaredStudyTopic: topic,
        initialDeclaredTopic: topic,
        pendingInitialTopic: null,
        seenPeerEdPubkeys: [],
        seenPeerNames: {},
        peerPresence: {},
      }
    }),
  setPendingInitialTopic: (topic) => set({ pendingInitialTopic: topic }),
  setDeclaredStudyTopic: (next) => set({ declaredStudyTopic: next }),
  peerJoined: (peerId) =>
    set((s) => {
      const existing = s.peers[peerId]
      return {
        hadAnyPeer: true,
        peers: {
          ...s.peers,
          [peerId]: existing
            ? // #264 — a stub from peerTransportLost resumes here. Its
              // identity binding stays cleared so the signed hello re-opens a
              // fresh overlap interval, exactly as a first join would.
              { ...existing, reconnecting: false }
            : {
                peerId,
                hasStream: false,
                ptt: false,
                reconnecting: false,
                edPubkeyHex: null,
                displayName: null,
                joinedAt: null,
              },
        },
      }
    }),
  peerLeft: (peerId, clock = currentPresenceClock()) =>
    departPeer(set, peerId, clock, false),
  peerTransportLost: (peerId, clock = currentPresenceClock()) =>
    departPeer(set, peerId, clock, true),
  peerReconnectExpired: (peerId) =>
    set((s) => {
      const stub = s.peers[peerId]
      if (!stub?.reconnecting) return s
      const peers = { ...s.peers }
      delete peers[peerId]
      return { peers }
    }),
  setPeerStream: (peerId, hasStream) =>
    set((s) => {
      const cur = s.peers[peerId]
      if (!cur) return s
      return { peers: { ...s.peers, [peerId]: { ...cur, hasStream } } }
    }),
  setPeerPtt: (peerId, active) =>
    set((s) => {
      const cur = s.peers[peerId]
      if (!cur) return s
      return { peers: { ...s.peers, [peerId]: { ...cur, ptt: active } } }
    }),
  setPeerHello: (peerId, hello, clock = currentPresenceClock()) =>
    set((s) => {
      // Hello can arrive before peerJoined (host->guest race on already-
      // present peers); upsert defensively so the binding always lands.
      const cur = s.peers[peerId] ?? {
        peerId,
        hasStream: false,
        ptt: false,
        reconnecting: false,
        edPubkeyHex: null,
        displayName: null,
        joinedAt: null,
      }
      // A transport peer is bound to the first verified identity it presents.
      // Rebinding it would corrupt both audit verification and overlap data.
      if (cur.edPubkeyHex !== null && cur.edPubkeyHex !== hello.ed_pubkey_hex) {
        return s
      }
      const seen = s.seenPeerEdPubkeys.includes(hello.ed_pubkey_hex)
        ? s.seenPeerEdPubkeys
        : [...s.seenPeerEdPubkeys, hello.ed_pubkey_hex]
      const identityAlreadyActive = Object.entries(s.peers).some(
        ([id, peer]) =>
          id !== peerId && peer.edPubkeyHex === hello.ed_pubkey_hex
      )
      const priorPresence = s.peerPresence[hello.ed_pubkey_hex] ?? {
        accumulatedMs: 0,
        activeSinceWall: null,
        activeSinceMono: null,
        lastEndedAt: null,
      }
      const shouldStart =
        cur.edPubkeyHex === null &&
        !identityAlreadyActive &&
        priorPresence.activeSinceWall === null &&
        priorPresence.activeSinceMono === null
      return {
        seenPeerEdPubkeys: seen,
        seenPeerNames: {
          ...s.seenPeerNames,
          [hello.ed_pubkey_hex]: hello.display_name,
        },
        peerPresence: {
          ...s.peerPresence,
          [hello.ed_pubkey_hex]: shouldStart
            ? {
                ...priorPresence,
                activeSinceWall: clock.wallMs,
                activeSinceMono: clock.monoMs,
              }
            : priorPresence,
        },
        peers: {
          ...s.peers,
          [peerId]: {
            ...cur,
            edPubkeyHex: hello.ed_pubkey_hex,
            displayName: hello.display_name,
            joinedAt: hello.joined_at,
          },
        },
      }
    }),
  collectPeerPubkeys: () => {
    // Cumulative set observed this session — NOT the live `peers` map,
    // which `peerLeft` has already emptied on the everyone-leaves path.
    const seen = get().seenPeerEdPubkeys
    if (seen.length === 0) return null
    const sorted = [...new Set(seen)].sort()
    return JSON.stringify(sorted)
  },
  finalizePeerPresence: (clock = currentPresenceClock()) => {
    let result: FinalizedPeerPresence = {
      durationsMs: {},
      lastStudiedAt: {},
    }
    set((s) => {
      const peerPresence: Record<string, PeerPresence> = {}
      const durationsMs: Record<string, number> = {}
      const lastStudiedAt: Record<string, number> = {}
      for (const edPubkeyHex of Object.keys(s.peerPresence).sort()) {
        const presence = s.peerPresence[edPubkeyHex]
        const active =
          presence.activeSinceWall !== null && presence.activeSinceMono !== null
        const finalized: PeerPresence = active
          ? {
              accumulatedMs:
                presence.accumulatedMs + overlapMs(presence, clock),
              activeSinceWall: null,
              activeSinceMono: null,
              lastEndedAt: clock.wallMs,
            }
          : presence
        peerPresence[edPubkeyHex] = finalized
        durationsMs[edPubkeyHex] = Math.max(
          0,
          Math.floor(finalized.accumulatedMs)
        )
        if (finalized.lastEndedAt !== null) {
          lastStudiedAt[edPubkeyHex] = finalized.lastEndedAt
        }
      }
      result = { durationsMs, lastStudiedAt }
      return { peerPresence }
    })
    return result
  },
  setPendingEndReason: (reason) =>
    set((s) =>
      s.pendingEndReason === null ? { pendingEndReason: reason } : s
    ),
  clearPendingEndReason: (reason) =>
    set((s) =>
      s.pendingEndReason === reason ? { pendingEndReason: null } : s
    ),
  setRejoinDeadline: (deadline) => set({ rejoinDeadline: deadline }),
  setReservedReconnectPeerIds: (peerIds) =>
    set({ reservedReconnectPeerIds: [...new Set(peerIds)].slice(0, 3) }),
  setFrozenGuestAdmission: (snapshot) =>
    set({
      frozenGuestAdmission:
        snapshot === null
          ? null
          : {
              authorityPeerId: snapshot.authorityPeerId,
              authorityEdPubkeyHex: snapshot.authorityEdPubkeyHex.toLowerCase(),
              admittedPeerIds: [...new Set(snapshot.admittedPeerIds)].slice(
                0,
                3
              ),
            },
    }),
  getRejoinRequest: (now = Date.now()) => {
    const s = get()
    if (
      s.status !== 'ended' ||
      s.endedBy !== 'user' ||
      s.rejoinDeadline === null ||
      now >= s.rejoinDeadline ||
      !s.sessionTopic ||
      !s.sessionPassword
    ) {
      return null
    }
    return {
      sessionTopic: s.sessionTopic,
      sessionPassword: s.sessionPassword,
      isHost: s.isHost,
      expectedAuthorityEdPubkeyHex: s.expectedAuthorityEdPubkeyHex,
      reservedReconnectPeerIds: s.reservedReconnectPeerIds,
      frozenGuestAdmission: s.frozenGuestAdmission,
    }
  },
  markEnded: () =>
    set((s) =>
      s.status === 'active'
        ? {
            status: 'ended',
            endedBy: s.pendingEndReason ?? 'user',
            pendingEndReason: null,
          }
        : s
    ),
  reset: () => set({ ...INITIAL }),
})

export function createSessionStore() {
  return create<SessionState>(sessionStateCreator)
}

export type SessionStore = ReturnType<typeof createSessionStore>

// Production uses one store per desktop webview. Tests that exercise multiple
// app instances in one process can inject stores created by the factory.
export const useSessionStore = createSessionStore()
