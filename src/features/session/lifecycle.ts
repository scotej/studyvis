import { toast } from 'sonner'

import { snapshotFocusForReport } from '@/features/ai/focusStore'
import { sessionTopic as deriveSessionTopic } from '@/lib/crypto/topics'
import {
  sessionsGet,
  sessionsInsert,
  type SessionRecord,
} from '@/lib/db/sessions'
import { bytesToBase64 } from '@/lib/encoding'
import { joinTopic, type TopicRoom } from '@/lib/trystero'
import { buildIceOptions } from '@/lib/trystero/ice'
import { userRelayConfig } from '@/lib/trystero/relays'
import { useAuditStore } from '@/stores/auditStore'
import { useFriendsStore } from '@/stores/friendsStore'
import { useSessionStore } from '@/stores/sessionStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { strings } from '@/strings'

export const SESSION_FULL_ACTION = 'session-full'
export const PTT_STATE_ACTION = 'ptt-state'
// S3 — broadcast the local camera on/off state so peers render an explicit
// "camera off" tile instead of the frozen last frame a disabled video track
// leaves behind. Mirrors the PTT_STATE_ACTION wire pattern.
export const CAMERA_STATE_ACTION = 'camera-state'
// 4-user mesh hard cap (host + 3 peers, ARCHITECTURE.md §7).
export const MAX_REMOTE_PEERS = 3
export const SESSION_FULL_MESSAGE = strings.session.full
// V2-P8 replaces the V2-P3 session-ended splash with the post-session
// report. The reset now runs when the user dismisses the report (via
// Report's Close button → useSessionStore.reset()), not on a timer. The
// constant + auto-reset timer have been retired; the V2-P3 splash was
// always documented as a placeholder for this report.

// F4 — maps an RTCPeerConnection.connectionState to the VideoTile focus state.
// Returns undefined when the tile should fall back to its stream-based default
// (`stream ? 'online' : 'offline'`): a connected peer with media up reads as
// `online`, and an unknown/absent connectionState defers to that fallback too.
//   - 'new' | 'connecting'        → 'connecting' (mid-ICE handshake)
//   - 'disconnected'              → 'connecting' (TRANSIENT: brief packet loss
//                                   on an otherwise-healthy link flickers
//                                   through this and self-heals to 'connected'
//                                   — never the terminal "Connection failed",
//                                   consistent with the S1 grace-window stance)
//   - 'failed'                    → 'failed'     (terminal: dead / dropped link)
//   - 'connected' | 'closed' | …  → undefined    (defer to stream fallback)
// Pure + exported so it's unit-testable without React.
export function connectionFocusState(
  connectionState: RTCPeerConnectionState | undefined,
  stream: MediaStream | null
): 'connecting' | 'failed' | undefined {
  switch (connectionState) {
    case 'failed':
      return 'failed'
    case 'new':
    case 'connecting':
    case 'disconnected':
      // Once media is flowing the tile is effectively live even if the
      // connectionState lags; let the stream fallback render 'online'.
      // 'disconnected' is recoverable, so it reads as 'connecting', not
      // 'failed', when media has dropped.
      return stream ? undefined : 'connecting'
    default:
      return undefined
  }
}

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
  // Honor the Settings → Network TURN preference on the actual study session,
  // not just the pairing handshake (mirrors runPair). Takes effect the instant
  // a TURN server is configured in ./ice; STUN-only otherwise.
  const ice = buildIceOptions(useSettingsStore.getState().values.turnPreference)
  const room = joinTopic({
    topic,
    password,
    relayConfig: userRelayConfig(),
    ...ice,
    onJoinError: logJoinError,
  })
  return { room, topic, password }
}

export function createGuestRoom(topic: string, password: string): RoomInit {
  const ice = buildIceOptions(useSettingsStore.getState().values.turnPreference)
  const room = joinTopic({
    topic,
    password,
    relayConfig: userRelayConfig(),
    ...ice,
    onJoinError: logJoinError,
  })
  return { room, topic, password }
}

// F1 — the session grid already surfaces per-peer connection state (F4), so a
// join error here just gets logged for diagnostics rather than driving a new UI
// surface. A guest whose offer never decrypts (impossible for a legitimate
// invite, since both sides share the session password) or a peer handshake
// timeout reads through here.
function logJoinError(details: { error: string }): void {
  console.warn('session room join error:', details.error)
}

// Re-entering the same room — Rejoin after a grace-window auto-end (#47 B3)
// or a guest re-invited to a live session they left earlier — runs a second
// leave cycle against the SAME topic-keyed sessions row. The Rust upsert is
// authoritative-overwrite for started_at/ended_at/total_minutes (I17: a
// re-summarize must be able to correct them), so persisting the tail stint
// verbatim would rewind the row: a 60-minute stint plus a 10-minute rejoin
// recorded 10 minutes starting at the rejoin, under-counting daily stats,
// silently breaking streaks, and collapsing stint-1 audit events into the
// timeline's 00:00. The one caller merges instead: earliest start, summed
// minutes (the between-stint gap is deliberately not studied time), union
// of peers. score/focused_pct stay last-scored-stint-wins via the Rust
// COALESCE — score continuity across a rejoin is a separate, larger change.
export function mergeSessionStints(
  prior: Pick<
    SessionRecord,
    'started_at' | 'total_minutes' | 'peer_pubkeys'
  > | null,
  stint: { startedAt: number; totalMinutes: number; peerPubkeys: string | null }
): { startedAt: number; totalMinutes: number; peerPubkeys: string | null } {
  if (!prior) return stint
  return {
    startedAt: Math.min(prior.started_at ?? stint.startedAt, stint.startedAt),
    totalMinutes: (prior.total_minutes ?? 0) + stint.totalMinutes,
    peerPubkeys: unionPeerPubkeys(prior.peer_pubkeys, stint.peerPubkeys),
  }
}

function parsePeerList(json: string | null): string[] {
  if (!json) return []
  try {
    const arr: unknown = JSON.parse(json)
    return Array.isArray(arr)
      ? arr.filter((x): x is string => typeof x === 'string')
      : []
  } catch {
    return []
  }
}

// Union in the canonical shape sessionStore.collectPeerPubkeys produces:
// sorted, deduped, NULL when empty (a peerless stint must not erase peers
// the prior stint saw — matching the Rust COALESCE's null-preserving intent).
function unionPeerPubkeys(a: string | null, b: string | null): string | null {
  const union = [...new Set([...parsePeerList(a), ...parsePeerList(b)])].sort()
  return union.length > 0 ? JSON.stringify(union) : null
}

// Injectable so the unit tests can drive a suspended machine without one;
// production reads the webview's monotonic clock.
const defaultMonotonicNow = (): number => performance.now()

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
  startedAtMono?: number
  monotonicNow?: () => number
}): () => Promise<void> {
  const monotonicNow = args.monotonicNow ?? defaultMonotonicNow
  let alreadyLeft = false
  return async () => {
    if (alreadyLeft) return
    alreadyLeft = true
    // #47 B3 follow-up — claim the end-reason SYNCHRONOUSLY, before the first
    // await: staging is first-writer-wins, so a deliberate Leave locks in
    // 'user' even if the grace deadline lands mid-teardown (the auto-end path
    // stages 'auto' before invoking this handler, so it still wins there).
    useSessionStore.getState().setPendingEndReason('user')
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
    // Persisted study minutes are the SHORTER of wall-clock and monotonic
    // elapsed. A laptop slept mid-session advances Date.now() across the whole
    // overnight span, so a 45-minute session ended by closing the lid used to
    // persist ~600 minutes — a fabricated streak day and a nonsense report.
    // performance.now() advances on demand rather than per tick, so a hidden
    // or throttled webview still reads the real awake span (no ticker to
    // starve), and min() can only ever shrink an inflated number: on a
    // platform whose monotonic clock does include suspend this degrades to
    // exactly the old wall-clock value instead of under-counting real study.
    const wallMs = endedAt - args.startedAt
    const monoMs =
      args.startedAtMono === undefined
        ? wallMs
        : monotonicNow() - args.startedAtMono
    const totalMinutes = Math.max(
      0,
      Math.floor(Math.min(wallMs, monoMs) / 60_000)
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

    // A prior row for this topic can only be an earlier stint of this same
    // session (the topic derives from 32 random bytes) — merge rather than
    // rewind it. Read failure degrades to stint-only values (pre-merge
    // behavior) instead of blocking persistence.
    let merged = { startedAt: args.startedAt, totalMinutes, peerPubkeys }
    try {
      merged = mergeSessionStints(await sessionsGet(args.topic), merged)
    } catch (err) {
      console.error('sessions_get for the re-entry merge failed:', err)
    }

    try {
      await sessionsInsert({
        id: args.topic,
        startedAt: merged.startedAt,
        endedAt,
        totalMinutes: merged.totalMinutes,
        peerPubkeys: merged.peerPubkeys,
        declaredTopic: initialDeclaredTopic,
        score: focusSnapshot.score,
        focusedPct: focusSnapshot.focusedPct,
        generatedAt: endedAt,
        confidentSamples: focusSnapshot.confidentSamples,
        skippedSamples: focusSnapshot.skippedSamples,
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

// S1 — grace window before the everyone-else-left auto-end fires. A WiFi blip
// drops the transport to every peer at once and trystero fires onPeerLeave for
// each, crashing the count to 0; without a debounce a 5-second hiccup
// irreversibly ends a 90-minute session. We arm a timer when the room empties
// and only run the leave handler if it's STILL empty when the timer expires.
// trystero re-fires onPeerJoin on reconnect (and the cumulative
// seenPeerEdPubkeys set in the session store survives the gap, so the report
// still records who we studied with). Injectable scheduler so the unit tests
// can drive it with a fake clock; production uses window timers.
export const DISCONNECT_GRACE_MS = 20_000

export type GraceScheduler = {
  setTimeout: (handler: () => void, ms: number) => number
  clearTimeout: (handle: number) => void
}

const defaultGraceScheduler: GraceScheduler = {
  setTimeout: (handler, ms) =>
    (globalThis.setTimeout as Window['setTimeout'])(handler, ms),
  clearTimeout: (handle) =>
    (globalThis.clearTimeout as Window['clearTimeout'])(handle),
}

// Wires onPeerJoin / onPeerLeave / 'session-full' on the trystero room. The
// host enforces the 4-user cap here (rejects the 4th remote peer); guests
// listen for 'session-full' and tear down with a toast. Both sides auto-end
// when peer count stays at 0 for DISCONNECT_GRACE_MS after at least one peer
// was present.
export function wireSessionRoom(
  room: TopicRoom,
  hooks: WireHooks,
  options?: { scheduler?: GraceScheduler; graceMs?: number }
): RoomLifecycle {
  const scheduler = options?.scheduler ?? defaultGraceScheduler
  const graceMs = options?.graceMs ?? DISCONNECT_GRACE_MS
  const peers = new Set<string>()
  let hadAny = false
  let graceHandle: number | null = null
  const sessionFull = room.makeAction<null>(SESSION_FULL_ACTION)

  const cancelGrace = (): void => {
    if (graceHandle !== null) {
      scheduler.clearTimeout(graceHandle)
      graceHandle = null
    }
  }

  const armGrace = (): void => {
    if (graceHandle !== null) return
    graceHandle = scheduler.setTimeout(() => {
      graceHandle = null
      // Only auto-end if the room is STILL empty — a reconnect within the
      // window cancels this via cancelGrace(). The leave handler is itself
      // idempotent, so an explicit user-leave racing the timer is safe.
      if (peers.size === 0) {
        // #47 B3 — stage the reason BEFORE the leave handler runs (first
        // writer wins; the handler itself stages 'user') so markEnded
        // records this as an auto-end and the Report can offer Rejoin (the
        // room may still be live without us after a >20s blip).
        useSessionStore.getState().setPendingEndReason('auto')
        void hooks.leave()
      }
    }, graceMs)
  }

  if (!hooks.isHost) {
    sessionFull.receive(() => {
      toast.error(SESSION_FULL_MESSAGE)
      cancelGrace()
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
    // A (re)join cancels a pending auto-end: the transport recovered before
    // the grace window expired.
    cancelGrace()
    peers.add(peerId)
    hadAny = true
    useSessionStore.getState().peerJoined(peerId)
  })

  room.onPeerLeave((peerId) => {
    if (!peers.has(peerId)) return
    peers.delete(peerId)
    useSessionStore.getState().peerLeft(peerId)
    if (peers.size === 0 && hadAny) {
      armGrace()
    }
  })

  return {
    peers: () => Array.from(peers),
  }
}
