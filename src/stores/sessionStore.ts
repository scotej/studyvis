// Zustand store for the live study-session lifecycle: status, the peers map,
// the declared-topic trio (see the three per-field comments below — they have
// distinct lifetimes), and the cumulative seen-peer sets that survive
// `peerLeft` on purpose so session history stays correct on the
// everyone-else-leaves auto-end path. Mutated by `features/session/*`
// (host/join/lifecycle/hello); read by SessionView, the AI sample loop, and
// the leave handler.

import { create } from 'zustand'

import type { TopicRoom } from '@/lib/trystero'

export type SessionStatus = 'idle' | 'active' | 'ended'

// #47 B3 — why the last session ended. 'auto' = the S1 grace window expired
// (a >20s connection blip), which is the one case where the room may still
// be live without us — the Report offers Rejoin there. 'user' covers every
// deliberate path (Leave click, double-Esc, confirmed quit, session-full
// eviction). null until a session has ended.
export type SessionEndReason = 'user' | 'auto'

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
  // Populated by the signed-hello handshake (V1-P9). Receivers gate audit-
  // event verification on this binding's presence; absent until hello arrives.
  edPubkeyHex: string | null
  displayName: string | null
  joinedAt: number | null
}

export type SessionInit = {
  sessionTopic: string
  sessionPassword: string
  isHost: boolean
  startedAt: number
  // performance.now() taken alongside startedAt. Optional so non-production
  // callers (tests, stories) can omit it; consumers fall back to wall clock.
  startedAtMono?: number
  room: TopicRoom
  leave: () => Promise<void>
}

// V2-P7 default until V2-P9 ships the required session-start topic input.
// Lives at module scope so SessionView + tests can reference the same
// literal when resetting the field.
export const DEFAULT_DECLARED_STUDY_TOPIC = 'Studying'

type SessionState = {
  status: SessionStatus
  // See SessionEndReason. Set by markEnded, cleared by begin/reset.
  endedBy: SessionEndReason | null
  // One-shot reason staged before the leave handler runs; markEnded consumes
  // it and defaults to 'user' when nothing was staged. FIRST writer wins
  // (see setPendingEndReason): the user path stages 'user' synchronously at
  // the top of buildLeaveHandler and the grace expiry stages 'auto' before
  // invoking it, so whichever path genuinely initiated the end owns the
  // attribution — a grace timer firing while a deliberate Leave's async
  // teardown is mid-flight can no longer rewrite it to 'auto'.
  pendingEndReason: SessionEndReason | null
  sessionTopic: string | null
  sessionPassword: string | null
  isHost: boolean
  startedAt: number | null
  // Monotonic origin for the same session start, so the live elapsed clock
  // (and the persisted total) can ignore time the machine spent asleep.
  startedAtMono: number | null
  hadAnyPeer: boolean
  peers: Record<string, PeerSnapshot>
  room: TopicRoom | null
  leave: (() => Promise<void>) | null
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
  // and `collectPeerPubkeys` read this so the normal everyone-else-leaves
  // auto-end path (where `peers` is already empty by the time the handler
  // snapshots) still records who we studied with. Cleared by begin/reset.
  seenPeerEdPubkeys: string[]
  // Cumulative ed_pubkey_hex → display_name observed via signed-hello this
  // session, never pruned by peerLeft (mirrors seenPeerEdPubkeys). The audit
  // panel reads this so a peer who leaves a still-running 3+ person session
  // keeps their name on past rows instead of falling back to a hex fragment.
  seenPeerNames: Record<string, string>
  begin: (init: SessionInit) => void
  setPendingInitialTopic: (topic: string | null) => void
  setDeclaredStudyTopic: (next: string) => void
  peerJoined: (peerId: string) => void
  peerLeft: (peerId: string) => void
  setPeerStream: (peerId: string, hasStream: boolean) => void
  setPeerPtt: (peerId: string, active: boolean) => void
  setPeerHello: (peerId: string, hello: PeerHello) => void
  // Returns sorted (lex) JSON-array string of every ed_pubkey_hex we've
  // observed via signed-hello in this session. Used by the leave handler to
  // populate sessions.peer_pubkeys. NULL until at least one hello arrived.
  collectPeerPubkeys: () => string | null
  setPendingEndReason: (reason: SessionEndReason) => void
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
  | 'sessionTopic'
  | 'sessionPassword'
  | 'isHost'
  | 'startedAt'
  | 'startedAtMono'
  | 'hadAnyPeer'
  | 'peers'
  | 'room'
  | 'leave'
  | 'declaredStudyTopic'
  | 'initialDeclaredTopic'
  | 'pendingInitialTopic'
  | 'seenPeerEdPubkeys'
  | 'seenPeerNames'
> = {
  status: 'idle',
  endedBy: null,
  pendingEndReason: null,
  sessionTopic: null,
  sessionPassword: null,
  isHost: false,
  startedAt: null,
  startedAtMono: null,
  hadAnyPeer: false,
  peers: {},
  room: null,
  leave: null,
  declaredStudyTopic: DEFAULT_DECLARED_STUDY_TOPIC,
  initialDeclaredTopic: DEFAULT_DECLARED_STUDY_TOPIC,
  pendingInitialTopic: null,
  seenPeerEdPubkeys: [],
  seenPeerNames: {},
}

export const useSessionStore = create<SessionState>((set, get) => ({
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
        sessionTopic: init.sessionTopic,
        sessionPassword: init.sessionPassword,
        isHost: init.isHost,
        startedAt: init.startedAt,
        startedAtMono: init.startedAtMono ?? null,
        hadAnyPeer: false,
        peers: {},
        room: init.room,
        leave: init.leave,
        declaredStudyTopic: topic,
        initialDeclaredTopic: topic,
        pendingInitialTopic: null,
        seenPeerEdPubkeys: [],
        seenPeerNames: {},
      }
    }),
  setPendingInitialTopic: (topic) => set({ pendingInitialTopic: topic }),
  setDeclaredStudyTopic: (next) => set({ declaredStudyTopic: next }),
  peerJoined: (peerId) =>
    set((s) => ({
      hadAnyPeer: true,
      peers: {
        ...s.peers,
        [peerId]: {
          peerId,
          hasStream: false,
          ptt: false,
          edPubkeyHex: null,
          displayName: null,
          joinedAt: null,
        },
      },
    })),
  peerLeft: (peerId) =>
    set((s) => {
      if (!(peerId in s.peers)) return s
      const next = { ...s.peers }
      delete next[peerId]
      return { peers: next }
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
  setPeerHello: (peerId, hello) =>
    set((s) => {
      // Hello can arrive before peerJoined (host->guest race on already-
      // present peers); upsert defensively so the binding always lands.
      const cur = s.peers[peerId] ?? {
        peerId,
        hasStream: false,
        ptt: false,
        edPubkeyHex: null,
        displayName: null,
        joinedAt: null,
      }
      const seen = s.seenPeerEdPubkeys.includes(hello.ed_pubkey_hex)
        ? s.seenPeerEdPubkeys
        : [...s.seenPeerEdPubkeys, hello.ed_pubkey_hex]
      return {
        seenPeerEdPubkeys: seen,
        seenPeerNames: {
          ...s.seenPeerNames,
          [hello.ed_pubkey_hex]: hello.display_name,
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
  setPendingEndReason: (reason) =>
    set((s) =>
      s.pendingEndReason === null ? { pendingEndReason: reason } : s
    ),
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
}))
