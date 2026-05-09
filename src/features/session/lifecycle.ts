import { toast } from 'sonner'

import { sessionTopic as deriveSessionTopic } from '@/lib/crypto/topics'
import { sessionsInsert } from '@/lib/db/sessions'
import { bytesToBase64 } from '@/lib/encoding'
import { joinTopic, type TopicRoom } from '@/lib/trystero'
import { useAuditStore } from '@/stores/auditStore'
import { usePomodoroStore } from '@/stores/pomodoroStore'
import { useSessionStore } from '@/stores/sessionStore'

export const SESSION_FULL_ACTION = 'session-full'
export const PTT_STATE_ACTION = 'ptt-state'
// 4-user mesh hard cap (host + 3 peers, ARCHITECTURE.md §7).
export const MAX_REMOTE_PEERS = 3
export const SESSION_FULL_MESSAGE = 'Session is full — max 4 friends'

export type SessionHandle = {
  sessionTopic: string
  sessionPassword: string
  room: TopicRoom
  leave: () => Promise<void>
  peers: () => readonly string[]
}

type RoomInit = {
  room: TopicRoom
  topic: string
  password: string
}

// Generates session_id (32 random bytes) + session_password (base64 of 32
// random bytes per ARCHITECTURE.md §6 step 4), derives session_topic, and
// joins the trystero room.
export function createHostRoom(): RoomInit {
  const sessionId = new Uint8Array(32)
  crypto.getRandomValues(sessionId)
  const passwordBytes = new Uint8Array(32)
  crypto.getRandomValues(passwordBytes)
  const password = bytesToBase64(passwordBytes)
  const topic = deriveSessionTopic(sessionId)
  const room = joinTopic({ topic, password })
  return { room, topic, password }
}

export function createGuestRoom(topic: string, password: string): RoomInit {
  const room = joinTopic({ topic, password })
  return { room, topic, password }
}

// Single teardown path: leaves trystero, computes a placeholder report, and
// upserts a sessions row keyed on session_topic. Each side persists its own
// row independently when the session ends — ARCHITECTURE.md §13 "peer count
// drops to 1 → generate report". Idempotent so onPeerLeave + click-Leave
// races don't double-write.
export function buildLeaveHandler(args: {
  room: TopicRoom
  topic: string
  startedAt: number
}): () => Promise<void> {
  let alreadyLeft = false
  return async () => {
    if (alreadyLeft) return
    alreadyLeft = true
    const endedAt = Date.now()
    try {
      await args.room.leave()
    } catch {
      // best-effort; persistence still runs
    }
    const totalMinutes = Math.max(
      0,
      Math.floor((endedAt - args.startedAt) / 60_000)
    )
    // Snapshot the peer-pubkey list BEFORE reset() clears the store. The
    // column is sorted JSON for canonicality regardless of join order.
    const peerPubkeys = useSessionStore.getState().collectPeerPubkeys()
    try {
      await sessionsInsert({
        id: args.topic,
        startedAt: args.startedAt,
        endedAt,
        totalMinutes,
        peerPubkeys,
      })
    } catch (err) {
      console.error('sessions_insert failed:', err)
    }
    // The store had a transient `ended` state, but reset() immediately
    // overwrites it — nothing renders the in-between phase, so we go
    // straight to idle. If a later phase wants a "session ended" splash
    // screen, reintroduce markEnded() and stage the reset behind a UI tick.
    useSessionStore.getState().reset()
    useAuditStore.getState().reset()
    usePomodoroStore.getState().reset()
  }
}

type WireHooks = {
  isHost: boolean
  leave: () => Promise<void>
}

export type RoomLifecycle = {
  peers: () => readonly string[]
}

// Wires onPeerJoin / onPeerLeave / 'session-full' on the trystero room. The
// host enforces the 4-user cap here (rejects the 4th remote peer); guests
// listen for 'session-full' and tear down with a toast. Both sides auto-end
// when peer count drops to 0 after at least one peer was present.
export function wireSessionRoom(
  room: TopicRoom,
  hooks: WireHooks
): RoomLifecycle {
  const peers = new Set<string>()
  let hadAny = false
  const sessionFull = room.makeAction<null>(SESSION_FULL_ACTION)

  if (!hooks.isHost) {
    sessionFull.receive(() => {
      toast.error(SESSION_FULL_MESSAGE)
      void hooks.leave()
    })
  }

  room.onPeerJoin((peerId) => {
    if (peers.has(peerId)) return
    if (hooks.isHost && peers.size >= MAX_REMOTE_PEERS) {
      // Reject the 4th remote peer (5th total user). The targeted action
      // lets the rejected peer show a toast and leave cleanly; the
      // .close() is a best-effort production safety net in case the
      // peer ignores the action — the bus mock used in tests has no
      // real RTCPeerConnection so the close is a no-op there.
      void sessionFull.send(null, peerId)
      try {
        const conn = room.getPeers()[peerId]
        conn?.close()
      } catch {
        // bus mock may not implement a real RTCPeerConnection
      }
      return
    }
    peers.add(peerId)
    hadAny = true
    useSessionStore.getState().peerJoined(peerId)
  })

  room.onPeerLeave((peerId) => {
    if (!peers.has(peerId)) return
    peers.delete(peerId)
    useSessionStore.getState().peerLeft(peerId)
    if (peers.size === 0 && hadAny) {
      void hooks.leave()
    }
  })

  return {
    peers: () => Array.from(peers),
  }
}
