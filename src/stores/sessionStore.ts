import { create } from 'zustand'

import type { TopicRoom } from '@/lib/trystero'

export type SessionStatus = 'idle' | 'active'

export type PeerSnapshot = {
  peerId: string
  hasStream: boolean
  ptt: boolean
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

export const useSessionStore = create<SessionState>((set) => ({
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
        [peerId]: { peerId, hasStream: false, ptt: false },
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
  reset: () => set({ ...INITIAL }),
}))

export function selectPeerCount(s: SessionState): number {
  return Object.keys(s.peers).length
}
