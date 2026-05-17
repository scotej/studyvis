import { toast } from 'sonner'

import { snapshotFocusForReport } from '@/features/ai/focusStore'
import { sessionTopic as deriveSessionTopic } from '@/lib/crypto/topics'
import { sessionsInsert } from '@/lib/db/sessions'
import { bytesToBase64 } from '@/lib/encoding'
import { joinTopic, type TopicRoom } from '@/lib/trystero'
import { useAuditStore } from '@/stores/auditStore'
import { useFriendsStore } from '@/stores/friendsStore'
import { useSessionStore } from '@/stores/sessionStore'

export const SESSION_FULL_ACTION = 'session-full'
export const PTT_STATE_ACTION = 'ptt-state'
// 4-user mesh hard cap (host + 3 peers, ARCHITECTURE.md §7).
export const MAX_REMOTE_PEERS = 3
export const SESSION_FULL_MESSAGE = 'Session is full — max 4 friends'
// V2-P8 replaces the V2-P3 session-ended splash with the post-session
// report. The reset now runs when the user dismisses the report (via
// Report's Close button → useSessionStore.reset()), not on a timer. The
// constant + auto-reset timer have been retired; the V2-P3 splash was
// always documented as a placeholder for this report.

export type SessionHandle = {
  sessionTopic: string
  sessionPassword: string
  room: TopicRoom
  leave: () => Promise<void>
  // Closure-bound peer set — used by integration tests (session.test.ts) for
  // per-instance inspection because the singleton `useSessionStore` is
  // overwritten by each subsequent `begin()`.
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

// Single teardown path: leaves trystero, generates the V2-P8 post-session
// report by snapshotting per-user score / focused-time / declared topic
// from in-memory stores BEFORE reset() clears anything, and upserts a
// sessions row keyed on session_topic. Each side persists its own row
// independently when the session ends — ARCHITECTURE.md §13 "peer count
// drops to 1 → generate report". Idempotent so onPeerLeave + click-Leave
// races don't double-write.
//
// The audit-store flush BEFORE the sessions upsert is load-bearing: the
// 'left' event (and any in-flight ai_alert from the closing exchange) is
// persisted via a fire-and-forget Tauri command in `auditStore.append`,
// so without flushPending() the report's first render races the SQLite
// commit for those last rows.
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
    // Snapshot every store field the report needs BEFORE room.leave so a
    // mid-teardown StrictMode / HMR double-mount can't wipe the values
    // (advisor-flagged invariant). The V2-P5 focusStore reset effect only
    // fires on 'active', so the score survives the 'ended' window in
    // practice — but capturing up front decouples us from that gate.
    const sessionState = useSessionStore.getState()
    const peerPubkeys = sessionState.collectPeerPubkeys()
    // Cumulative set, not the live `peers` map: on the everyone-else-leaves
    // auto-end path `peerLeft` has already pruned every entry by now.
    const peerEdPubkeys = [...new Set(sessionState.seenPeerEdPubkeys)]
    const initialDeclaredTopic = sessionState.initialDeclaredTopic
    const focusSnapshot = snapshotFocusForReport()
    const totalMinutes = Math.max(
      0,
      Math.floor((endedAt - args.startedAt) / 60_000)
    )

    try {
      await args.room.leave()
    } catch {
      // best-effort; persistence still runs
    }

    // Make sure every audit_event_insert kicked off during the session
    // (including the very last 'left' row from our own emit a few ticks
    // ago) has landed in SQLite before the report queries audit_events.
    try {
      await useAuditStore.getState().flushPending()
    } catch (err) {
      console.error('audit flushPending failed:', err)
    }

    try {
      await sessionsInsert({
        id: args.topic,
        startedAt: args.startedAt,
        endedAt,
        totalMinutes,
        peerPubkeys,
        declaredTopic: initialDeclaredTopic,
        score: focusSnapshot.score,
        focusedPct: focusSnapshot.focusedPct,
        generatedAt: endedAt,
      })
    } catch (err) {
      console.error('sessions_insert failed:', err)
    }
    try {
      await useFriendsStore.getState().markStudied(peerEdPubkeys, endedAt)
    } catch (err) {
      console.error('markStudied failed:', err)
    }
    // Flip to 'ended'. The Report view (mounted by Home.tsx when status ===
    // 'ended') queries the just-persisted sessions row + audit_events for
    // this topic. Reset of audit + pomodoro stores is driven by the V2-P5
    // reset effect in SessionView the next time a session begins (handles
    // the invite-while-on-report path); the V2-P3 1.5 s auto-reset has
    // been retired alongside the SessionEndedSplash.
    useSessionStore.getState().markEnded()
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
