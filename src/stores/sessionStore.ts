import { create } from 'zustand'

import type { TopicRoom } from '@/lib/trystero'

export type SessionStatus = 'idle' | 'active'

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
  begin: (init: SessionInit) => void
  peerJoined: (peerId: string) => void
  peerLeft: (peerId: string) => void
  setPeerStream: (peerId: string, hasStream: boolean) => void
  setPeerPtt: (peerId: string, active: boolean) => void
  setPeerHello: (peerId: string, hello: PeerHello) => void
  // Returns sorted (lex) JSON-array string of every ed_pubkey_hex we've
  // observed via signed-hello in this session. Used by the leave handler to
  // populate sessions.peer_pubkeys. NULL until at least one hello arrived.
  collectPeerPubkeys: () => string | null
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
    }),
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
  reset: () => set({ ...INITIAL }),
}))
