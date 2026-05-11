import { create } from 'zustand'

import type { TopicRoom } from '@/lib/trystero'

export type SessionStatus = 'idle' | 'active' | 'ended'

// Snapshot rendered by SessionEndedSplash during the SESSION_ENDED_SPLASH_MS
// window after a session closes. Captured by lifecycle.ts in the leave
// handler before the peers map is cleared by reset().
export type SessionEndedSnapshot = {
  // Wall-clock seconds the session ran for, or null if the session never
  // had a startedAt (defensive — should not happen in practice).
  durationSeconds: number | null
  // Display names of the peers present at end time, in arbitrary order.
  peerNames: string[]
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
  room: TopicRoom
  leave: () => Promise<void>
}

// V2-P7 default until V2-P9 ships the required session-start topic input.
// Lives at module scope so SessionView + tests can reference the same
// literal when resetting the field.
export const DEFAULT_DECLARED_STUDY_TOPIC = 'Studying'

type SessionState = {
  status: SessionStatus
  sessionTopic: string | null
  sessionPassword: string | null
  isHost: boolean
  startedAt: number | null
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
  begin: (init: SessionInit) => void
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
  // Flip status to 'ended' AND publish the splash snapshot in one mutation
  // so the session view can render the SessionEndedSplash with stable
  // content for its full lifetime. lifecycle.ts is the only caller — it
  // computes durationSeconds and peerNames from the live state right
  // before markEnded so the values reflect the session that just closed.
  // Followed by `reset()` after SESSION_ENDED_SPLASH_MS.
  endedSnapshot: SessionEndedSnapshot | null
  markEnded: (snapshot: SessionEndedSnapshot) => void
  reset: () => void
}

const INITIAL: Pick<
  SessionState,
  | 'status'
  | 'sessionTopic'
  | 'sessionPassword'
  | 'isHost'
  | 'startedAt'
  | 'hadAnyPeer'
  | 'peers'
  | 'room'
  | 'leave'
  | 'endedSnapshot'
  | 'declaredStudyTopic'
> = {
  status: 'idle',
  sessionTopic: null,
  sessionPassword: null,
  isHost: false,
  startedAt: null,
  hadAnyPeer: false,
  peers: {},
  room: null,
  leave: null,
  endedSnapshot: null,
  declaredStudyTopic: DEFAULT_DECLARED_STUDY_TOPIC,
}

export const useSessionStore = create<SessionState>((set, get) => ({
  ...INITIAL,
  begin: (init) =>
    set({
      status: 'active',
      sessionTopic: init.sessionTopic,
      sessionPassword: init.sessionPassword,
      isHost: init.isHost,
      startedAt: init.startedAt,
      hadAnyPeer: false,
      peers: {},
      room: init.room,
      leave: init.leave,
      declaredStudyTopic: DEFAULT_DECLARED_STUDY_TOPIC,
    }),
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
      return {
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
    const seen = new Set<string>()
    for (const p of Object.values(get().peers)) {
      if (p.edPubkeyHex) seen.add(p.edPubkeyHex)
    }
    if (seen.size === 0) return null
    const sorted = Array.from(seen).sort()
    return JSON.stringify(sorted)
  },
  markEnded: (snapshot) =>
    set((s) =>
      s.status === 'active' ? { status: 'ended', endedSnapshot: snapshot } : s
    ),
  reset: () => set({ ...INITIAL }),
}))
