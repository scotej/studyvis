import { toast } from 'sonner'

import { snapshotFocusForReport } from '@/features/ai/focusStore'
import { sessionTopic as deriveSessionTopic } from '@/lib/crypto/topics'
import {
  sessionsGet,
  sessionsInsert,
  sessionsInsertIfAbsent,
  type SessionRecord,
  type SessionRow,
} from '@/lib/db/sessions'
import {
  capPeerPresenceMs,
  decodePeerPresenceMsForPeers,
  encodePeerPresenceMs,
  maxPeerPresenceMs,
  mergePeerPresenceMs,
} from '@/lib/db/sessionPresence'
import { bytesToBase64 } from '@/lib/encoding'
import { joinTopic, type TopicRoom } from '@/lib/trystero'
import {
  closeTransport,
  transportHealthOf,
} from '@/lib/webrtc/resilientPeerConnection'
import { buildIceOptions } from '@/lib/trystero/ice'
import { userRelayConfig } from '@/lib/trystero/relays'
import { useAuditStore } from '@/stores/auditStore'
import { useFriendsStore } from '@/stores/friendsStore'
import {
  useSessionStore,
  type GuestAdmissionSnapshot,
  type SessionStore,
} from '@/stores/sessionStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { strings } from '@/strings'
import { flushLog, logger, setLogContext } from '@/lib/log'

import { clearSessionRecoveryOnLeave } from './recovery'

const log = logger.child('session.lifecycle')

export type SessionRole = 'host' | 'guest'

// Start the share-safe diagnostic timeline before any room callbacks can
// fire. The full topic is a room join capability; setLogContext keeps only its
// eight-character correlation prefix. Settings are reduced to categorical
// state/counts so no custom relay URL, TURN credential or declared topic can
// reach the log.
export function beginSessionDiagnostics(
  topic: string,
  role: SessionRole
): void {
  setLogContext({ sess: topic })
  const settings = useSettingsStore.getState().values
  log.info('session.begin', {
    role,
    aiEnabled: settings.aiFeaturesEnabled,
    captureMode: settings.captureDisplays,
    turnPreference: settings.turnPreference,
    turnConfigured: settings.turnServer !== null,
    customRelayCount: settings.customRelayUrls.length,
  })
}

export const SESSION_FULL_ACTION = 'session-full'
export const PTT_STATE_ACTION = 'ptt-state'
// S3 — broadcast the local camera on/off state so peers render an explicit
// "camera off" tile instead of the frozen last frame a disabled video track
// leaves behind. Mirrors the PTT_STATE_ACTION wire pattern.
export const CAMERA_STATE_ACTION = 'camera-state'
// 4-user mesh hard cap (host + 3 peers, ARCHITECTURE.md §7).
export const MAX_REMOTE_PEERS = 3

// #264 — how long a peer whose transport dropped uncleanly keeps its tile,
// marked "Reconnecting…", before it is treated as gone. The lib/webrtc hold
// already absorbs a blip without anyone leaving at all; this covers the
// longer case where trystero does declare the peer closed and then
// re-establishes it. Re-establishment is only possible because the departure
// path closes the abandoned connection (see the onPeerLeave handler): while
// it stays open, trystero reads it as a live connected peer and drops every
// signaling message for that peerId, so no amount of waiting would help.
// Presence accounting is closed at the drop, not here, so a session ended
// mid-grace cannot over-count overlap.
export const PEER_RECONNECT_GRACE_MS = 30_000
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
//                                   — never the terminal "Connection failed";
//                                   the transport may still recover in place)
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

// I77 — publish the local camera/mic stream to EVERY peer, present and future.
//
// An untargeted `room.addStream` reaches only the peers that are active at the
// instant it is called, and trystero never re-sends it to anyone who joins
// afterwards: `addStream` → `applyMediaOp` → `iterate` enumerates
// `keys(activePeerMap)` right then (@trystero-p2p/core room.mjs:83, :494), and
// peer activation (room.mjs:306-314) only fires `onPeerJoin` — it replays no
// previously added local stream. A host derives a fresh random topic and
// acquires media while provably alone, so the lone broadcast landed on nobody
// and the host's camera + mic never reached a single guest, in any build.
//
// The two statements below MUST stay adjacent with no `await` between them:
// the broadcast covers whoever is active now, the subscriber covers whoever
// arrives later, and JS's single thread closes the seam so a peer can neither
// be missed nor served twice (a double-add desyncs trystero's FIFO pairing of
// stream metadata to tracks). Keeping them inside one function is what makes
// that invariant structural instead of a comment someone edits between.
//
// Returns an unsubscribe that MUST run before the stream's tracks are stopped,
// or a "Try again" re-acquire would hand a later joiner a dead stream.
export function publishLocalStream(
  room: TopicRoom,
  stream: MediaStream
): () => void {
  room.addStream(stream)
  return room.onPeerJoin((peerId) => {
    room.addStream(stream, peerId)
  })
}

export type SessionHandle = {
  sessionTopic: string
  sessionPassword: string
  room: TopicRoom
  leave: () => Promise<void>
  // Closure-bound peer set for lightweight per-room inspection. The app reads
  // the corresponding store; integration tests use both views to assert the
  // room membership and injected-store lifecycle stay aligned.
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
  // trystero assembles this string around remote peer data, so it is
  // untrusted text — the logger sanitises it on the way in.
  log.warn('join.error', { room: 'session', joinError: details.error })
}

// Re-entering the same room — Rejoin after a local Leave (#47 B3) or a guest
// re-invited to a live session they left earlier — runs a second
// leave cycle against the SAME topic-keyed sessions row. The Rust upsert is
// authoritative-overwrite for started_at/ended_at/total_minutes (I17: a
// re-summarize must be able to correct them), so persisting the tail stint
// verbatim would rewind the row: a 60-minute stint plus a 10-minute rejoin
// recorded 10 minutes starting at the rejoin, under-counting daily stats,
// silently breaking streaks, and collapsing stint-1 audit events into the
// timeline's 00:00. The one caller merges instead: earliest start, summed
// duration (the between-stint gap is deliberately not studied time), union
// of peers and sums each peer's measured overlap. `total_duration_ms` retains
// sub-minute residue, so two 30-second stints become one minute. Focus score/tallies continue
// in memory across a rejoin, so this second upsert carries metrics for the
// whole logical session too.
export function mergeSessionStints(
  prior: Pick<
    SessionRecord,
    | 'started_at'
    | 'total_minutes'
    | 'total_duration_ms'
    | 'peer_pubkeys'
    | 'peer_presence_ms'
  > | null,
  stint: {
    startedAt: number
    totalMinutes: number | null
    totalDurationMs: number
    peerPubkeys: string | null
    peerPresenceMs: string
  }
): {
  startedAt: number
  totalMinutes: number | null
  totalDurationMs: number | null
  peerPubkeys: string | null
  peerPresenceMs: string | null
} {
  if (!prior) return stint
  const priorDuration = priorDurationMs(prior)
  const mergedLowerBoundMs = addDurationMs(
    priorDuration.lowerBoundMs,
    normalizeDurationMs(stint.totalDurationMs)
  )
  const totalDurationMs =
    priorDuration.exactMs === null
      ? null
      : addDurationMs(
          priorDuration.exactMs,
          normalizeDurationMs(stint.totalDurationMs)
        )
  const priorPeers = parsePeerList(prior.peer_pubkeys)
  const hasAuthoritativePriorPeerPresence =
    decodePeerPresenceMsForPeers(prior.peer_presence_ms, priorPeers) !== null
  // A legacy row can identify its earlier partner(s) without measuring each
  // overlap. Adding a new tail peer to that row would make legacy stats credit
  // the new peer with the entire historical total. Keep that bounded older
  // attribution intact; the tail remains visible in audit/friend metadata.
  const preservePriorPeerAttribution =
    totalDurationMs === null &&
    !hasAuthoritativePriorPeerPresence &&
    // A legacy solo row can still carry proven whole minutes while containing
    // no peer identities at all. Attaching a rejoin-tail peer to that row
    // would credit it with the older solo time in legacy stats.
    (priorPeers.length > 0 ||
      (prior.peer_pubkeys === null && (prior.total_minutes ?? 0) > 0))
  return {
    startedAt: Math.min(prior.started_at ?? stint.startedAt, stint.startedAt),
    // A trusted exact total remains the source of truth. The lower-bound path
    // is only for legacy/invalid precision, where the peer map is useful but
    // must not be mistaken for a cap.
    totalMinutes:
      totalDurationMs === null && prior.total_minutes === null
        ? null
        : totalDurationMs === null && mergedLowerBoundMs < 60_000
          ? null
          : Math.floor((totalDurationMs ?? mergedLowerBoundMs) / 60_000),
    totalDurationMs,
    peerPubkeys: preservePriorPeerAttribution
      ? prior.peer_pubkeys
      : unionPeerPubkeys(prior.peer_pubkeys, stint.peerPubkeys),
    // Unknown precision is contagious. A precisely measured tail cannot make
    // a legacy or malformed earlier stint precise retroactively.
    peerPresenceMs: preservePriorPeerAttribution
      ? null
      : totalDurationMs === null
        ? mergePeerPresenceMs(prior.peer_presence_ms, stint.peerPresenceMs)
        : capPeerPresenceMs(
            mergePeerPresenceMs(prior.peer_presence_ms, stint.peerPresenceMs),
            totalDurationMs
          ),
  }
}

function normalizeDurationMs(value: number | null | undefined): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0
}

function addDurationMs(a: number, b: number): number {
  const total = a + b
  // An actual study session cannot approach this boundary, but a corrupted
  // local row must not turn a Leave into an unrepresentable IPC number.
  return Number.isSafeInteger(total) ? total : Number.MAX_SAFE_INTEGER
}

function priorDurationMs(
  prior: Pick<
    SessionRecord,
    'total_duration_ms' | 'total_minutes' | 'peer_presence_ms'
  >
): { exactMs: number | null; lowerBoundMs: number } {
  // A durable exact value can still be stale after an interrupted old/new
  // writer upgrade. Reconcile every representation rather than trusting an
  // apparently valid zero and silently truncating known study time.
  const exact = trustedDurationMs(prior)
  // 006 can already contain exact per-peer intervals while the local total
  // was still rounded down to minutes. Keep the largest representation as an
  // honest lower bound when a 007 writer continues that logical session.
  const wholeMinuteLowerBound = Math.min(
    Number.MAX_SAFE_INTEGER,
    normalizeDurationMs(prior.total_minutes) * 60_000
  )
  const lowerBoundMs = Math.max(
    exact ?? 0,
    wholeMinuteLowerBound,
    maxPeerPresenceMs(prior.peer_presence_ms) ?? 0
  )
  return { exactMs: exact, lowerBoundMs }
}

function trustedDurationMs(
  session: Pick<SessionRecord, 'total_duration_ms' | 'total_minutes'>
): number | null {
  const duration = session.total_duration_ms
  const minutes = session.total_minutes
  if (
    typeof duration !== 'number' ||
    !Number.isSafeInteger(duration) ||
    duration < 0 ||
    typeof minutes !== 'number' ||
    !Number.isSafeInteger(minutes) ||
    minutes < 0
  ) {
    return null
  }
  // A 007 value is exact only when its persisted whole-minute projection
  // agrees. Old/new writers and interrupted re-entries can leave a plausible
  // number beside incompatible legacy data; treating that as exact would cap
  // known peer overlap and manufacture precision on the next rejoin.
  return Math.floor(duration / 60_000) === minutes ? duration : null
}

type PersistedFocusMetrics = {
  score: number | null
  focusedPct: number | null
  confidentSamples: number | null
  skippedSamples: number | null
  aiEnabled: number | null
}

function mergeAiEnabled(
  prior: Pick<
    SessionRecord,
    'ai_enabled' | 'confident_samples' | 'skipped_samples'
  >,
  stintAiEnabled: number
): number | null {
  // Older rows may predate ai_enabled while still carrying sample counters;
  // those counters prove AI ran. Otherwise preserve unknown unless either
  // stint positively says AI was enabled.
  const priorAiEnabled =
    prior.ai_enabled ??
    (prior.confident_samples !== null || prior.skipped_samples !== null
      ? 1
      : null)
  if (priorAiEnabled === 1 || stintAiEnabled === 1) return 1
  if (priorAiEnabled === 0 && stintAiEnabled === 0) return 0
  return null
}

// A score contains streak state, so it cannot be mathematically combined once
// a second stint started from a fresh machine. Focused-time can be combined
// only from its raw denominator/numerator; if either is unavailable, retain
// unknown rather than making a percentage for only one part of the session.
export function mergeDiscontinuousFocusMetrics(
  prior: Pick<
    SessionRecord,
    | 'score'
    | 'focused_pct'
    | 'confident_samples'
    | 'skipped_samples'
    | 'ai_enabled'
  >,
  stint: ReturnType<typeof snapshotFocusForReport>
): PersistedFocusMetrics {
  const priorConfident = prior.confident_samples
  const stintConfident = stint.confidentSamples
  const totalConfident =
    priorConfident === null || stintConfident === null
      ? null
      : priorConfident + stintConfident
  const canRecoverPriorFocused =
    priorConfident === 0 || prior.focused_pct !== null
  const canRecoverStintFocused =
    stintConfident === 0 || stint.focusedPct !== null
  const focusedPct =
    totalConfident === null ||
    totalConfident === 0 ||
    !canRecoverPriorFocused ||
    !canRecoverStintFocused
      ? null
      : (Math.round(priorConfident! * (prior.focused_pct ?? 0)) +
          Math.round(stintConfident! * (stint.focusedPct ?? 0))) /
        totalConfident
  return {
    // Never revive or average a streak-derived score from independent state
    // machines. The Rust replace mode below makes this NULL durable.
    score: null,
    focusedPct,
    confidentSamples: totalConfident,
    skippedSamples:
      prior.skipped_samples === null || stint.skippedSamples === null
        ? null
        : prior.skipped_samples + stint.skippedSamples,
    aiEnabled: mergeAiEnabled(prior, stint.aiEnabled),
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
// independently when that local user leaves. Remote peer membership never
// invokes this path. Idempotent so repeated local actions or a session-full
// callback cannot double-write.
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
  // Defaults to the production webview singleton. Integration tests inject
  // one store per simulated app instance so lifecycle isolation is real.
  store?: SessionStore
  // Bound by hostSession/joinSession at the start of this stint. The SQL
  // upsert preserves the original row verbatim (including legacy unknown),
  // so a logical session's owner can never be rewritten by a later identity
  // change or rejoin.
  localEdPubkey?: string | null
  localDisplayName?: string | null
  // True only when the focus store was deliberately carried from the prior
  // stint (explicit Rejoin or same-topic invite while its Report is open).
  // False gives cross-process/memory-loss re-entry an honest score-null
  // fallback instead of silently applying a last-stint score to total time.
  continuesFocus?: boolean
  // Invoked exactly once after all synchronous/preflight state is captured
  // and immediately before room teardown becomes non-retryable. Wrappers use
  // this to dispose room-scoped observers without sacrificing a retry when a
  // preflight read throws.
  onTeardownCommitted?: () => void
}): () => Promise<void> {
  const monotonicNow = args.monotonicNow ?? defaultMonotonicNow
  const sessionStore = args.store ?? useSessionStore
  let leaveAttempt: Promise<void> | null = null
  let teardownCommitted = false
  const performLeave = async () => {
    // Claim the end reason synchronously before the first await. The caller's
    // UI path does the same before broadcasting `left`; this second claim is
    // harmless and keeps direct handle.leave() calls correctly attributed.
    sessionStore.getState().setPendingEndReason('user')
    const endedAt = Date.now()
    const endedAtMono = monotonicNow()
    // Snapshot every store field the report needs BEFORE room.leave so a
    // mid-teardown StrictMode / HMR double-mount can't wipe the values
    // (advisor-flagged invariant). The V2-P5 focusStore reset effect only
    // fires on 'active', so the score survives the 'ended' window in
    // practice — but capturing up front decouples us from that gate.
    const sessionState = sessionStore.getState()
    const endReason = sessionState.pendingEndReason ?? 'user'
    const rejoinable = sessionState.hadAnyPeer && endReason === 'user'
    sessionState.setRejoinDeadline(
      rejoinable ? endedAt + REJOIN_WINDOW_MS : null
    )
    // Trystero's local leave clears peer state and can synchronously fire the
    // lifecycle's peer-left listeners. Preserve the host's live incumbents
    // before that teardown so its same-ID rejoin can reserve exactly those
    // slots against a delayed fifth connection.
    sessionState.setReservedReconnectPeerIds(
      rejoinable && sessionState.isHost ? Object.keys(sessionState.peers) : []
    )
    const peerPubkeys = sessionState.collectPeerPubkeys()
    const peerEdPubkeys = [...new Set(sessionState.seenPeerEdPubkeys)]
    // Close active authenticated intervals before room.leave() can emit peer
    // callbacks. The store finalizer is idempotent, so each interval is added
    // at most once and every new session — including a solo one — writes a
    // non-null precision object.
    const finalizedPresence = sessionState.finalizePeerPresence({
      wallMs: endedAt,
      monoMs: endedAtMono,
    })
    const peerPresenceMs = encodePeerPresenceMs(finalizedPresence.durationsMs)
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
        : endedAtMono - args.startedAtMono
    const totalDurationMs = Math.max(0, Math.floor(Math.min(wallMs, monoMs)))
    const totalMinutes = Math.floor(totalDurationMs / 60_000)

    log.info('session.end_started', {
      role: sessionState.isHost ? 'host' : 'guest',
      endReason,
      livePeerCount: Object.keys(sessionState.peers).length,
      seenPeerCount: peerEdPubkeys.length,
      hadAnyPeer: sessionState.hadAnyPeer,
      wallMs,
      awakeMs: monoMs,
    })

    // From the first room-leave attempt onward, retrying the whole stint would
    // risk merging its minutes/presence twice. Expected teardown failures are
    // handled below; any preflight failure releases the cached attempt.
    teardownCommitted = true
    // #225 — the local session is definitively ending, so the launch-time
    // recovery record goes with it. A confirmed quit is the one exception:
    // it runs this same handler, and being able to come back is the point.
    void clearSessionRecoveryOnLeave()
    try {
      args.onTeardownCommitted?.()
    } catch (err) {
      // Wrapper-local teardown (subscriptions/UI) cannot prevent the durable
      // room leave and session persistence after this non-retryable boundary.
      log.warn('session.teardown_commit_hook_failed', { err })
    }
    try {
      await args.room.leave()
      log.debug('room.leave_succeeded')
    } catch (err) {
      // best-effort; persistence still runs
      log.warn('room.leave_failed', { err })
    }

    // Make sure every audit_event_insert kicked off during the session
    // (including the very last 'left' row from our own emit a few ticks
    // ago) has landed in SQLite before the report queries audit_events.
    let auditFlushed = false
    try {
      await useAuditStore.getState().flushPending()
      auditFlushed = true
      log.debug('audit_flush.succeeded', { phase: 'teardown' })
    } catch (err) {
      log.error('audit_flush.failed', { phase: 'teardown', err })
    }

    const stint = {
      startedAt: args.startedAt,
      totalMinutes,
      totalDurationMs,
      peerPubkeys,
      peerPresenceMs,
    }
    const buildSessionRow = (
      summary: ReturnType<typeof mergeSessionStints>,
      focus: PersistedFocusMetrics,
      replaceFocusMetrics: boolean
    ): SessionRow => ({
      id: args.topic,
      startedAt: summary.startedAt,
      endedAt,
      totalMinutes: summary.totalMinutes,
      totalDurationMs: summary.totalDurationMs,
      peerPubkeys: summary.peerPubkeys,
      peerPresenceMs: summary.peerPresenceMs,
      declaredTopic: initialDeclaredTopic,
      score: focus.score,
      focusedPct: focus.focusedPct,
      generatedAt: endedAt,
      confidentSamples: focus.confidentSamples,
      skippedSamples: focus.skippedSamples,
      aiEnabled: focus.aiEnabled,
      localEdPubkey: args.localEdPubkey ?? null,
      localDisplayName: args.localDisplayName ?? null,
      replaceFocusMetrics,
    })

    // A prior row for this topic can only be an earlier stint of this same
    // session (the topic derives from 32 random bytes) — merge rather than
    // rewind it. Retry one transient read failure. If the row is still
    // indeterminate, use an atomic insert-if-absent: that retains a first-ever
    // stint but cannot overwrite an existing session with tail-stint values.
    let merged: ReturnType<typeof mergeSessionStints> = stint
    let priorStintFound = false
    let priorStintReadSucceeded = false
    let priorStint: SessionRecord | null = null
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const prior = await sessionsGet(args.topic)
        // IPC promises should resolve null for an absent row, but normalize an
        // undefined mock/older bridge response too: it is absence, never a row
        // whose focus fields may be read below.
        priorStintFound = prior != null
        priorStint = prior ?? null
        merged = mergeSessionStints(priorStint, stint)
        priorStintReadSucceeded = true
        log.debug('sessions_get.succeeded', { priorStintFound, attempt })
        break
      } catch (err) {
        if (attempt === 1) {
          log.warn('sessions_get.retrying', { attempt, err })
        } else {
          log.error('sessions_get.failed', {
            attempts: attempt,
            fallback: 'insert-if-absent',
            err,
          })
        }
      }
    }

    let sessionPersisted = false
    if (priorStintReadSucceeded) {
      try {
        const discontinuousFocus = priorStint !== null && !args.continuesFocus
        const persistedFocus =
          priorStint !== null && !args.continuesFocus
            ? mergeDiscontinuousFocusMetrics(priorStint, focusSnapshot)
            : priorStint !== null
              ? {
                  ...focusSnapshot,
                  aiEnabled: mergeAiEnabled(
                    priorStint,
                    focusSnapshot.aiEnabled
                  ),
                }
              : focusSnapshot
        await sessionsInsert(
          buildSessionRow(merged, persistedFocus, discontinuousFocus)
        )
        sessionPersisted = true
        log.debug('sessions_insert.succeeded', {
          priorStintFound,
          totalMinutes: merged.totalMinutes,
          seenPeerCount: peerEdPubkeys.length,
        })
      } catch (err) {
        log.error('sessions_insert.failed', {
          totalMinutes: merged.totalMinutes,
          peerCount: peerEdPubkeys.length,
          scoreRecorded: focusSnapshot.score !== null,
          focusedPctRecorded: focusSnapshot.focusedPct !== null,
          confidentSamples: focusSnapshot.confidentSamples,
          skippedSamples: focusSnapshot.skippedSamples,
          err,
        })
      }
    } else {
      try {
        sessionPersisted = await sessionsInsertIfAbsent(
          buildSessionRow(stint, focusSnapshot, false)
        )
        log.debug('sessions_insert_if_absent.succeeded', {
          inserted: sessionPersisted,
          totalMinutes: stint.totalMinutes,
          seenPeerCount: peerEdPubkeys.length,
        })
      } catch (err) {
        log.error('sessions_insert_if_absent.failed', {
          totalMinutes: stint.totalMinutes,
          peerCount: peerEdPubkeys.length,
          scoreRecorded: focusSnapshot.score !== null,
          focusedPctRecorded: focusSnapshot.focusedPct !== null,
          confidentSamples: focusSnapshot.confidentSamples,
          skippedSamples: focusSnapshot.skippedSamples,
          err,
        })
      }
    }
    let friendsUpdated = false
    try {
      await useFriendsStore
        .getState()
        .markStudiedAt(
          Object.entries(finalizedPresence.lastStudiedAt).map(
            ([edPubkey, ts]) => ({ edPubkey, ts })
          )
        )
      friendsUpdated = true
      log.debug('mark_studied.succeeded', {
        peerCount: peerEdPubkeys.length,
      })
    } catch (err) {
      log.error('mark_studied.failed', {
        peerCount: peerEdPubkeys.length,
        err,
      })
    }
    log.info('session.end_completed', {
      endReason,
      rejoinDeadline: rejoinable ? endedAt + REJOIN_WINDOW_MS : null,
      totalMinutes: merged.totalMinutes,
      seenPeerCount: peerEdPubkeys.length,
      scoreRecorded: focusSnapshot.score !== null,
      confidentSamples: focusSnapshot.confidentSamples,
      skippedSamples: focusSnapshot.skippedSamples,
      auditFlushed,
      sessionPersisted,
      friendsUpdated,
    })
    // The next screen is precisely where issue #161 puts the export button.
    // Make the end markers durable before the report can be rendered/saved.
    try {
      await flushLog()
    } catch (err) {
      // Logging durability is best-effort and must not strand an already-left
      // user in the active session UI.
      log.error('log_flush.failed', { phase: 'teardown', err })
    }
    // Flip to 'ended'. The Report view (mounted by Home.tsx when status ===
    // 'ended') queries the just-persisted sessions row + audit_events for
    // this topic. Reset of audit + pomodoro stores is driven by the V2-P5
    // reset effect in SessionView the next time a session begins (handles
    // the invite-while-on-report path); the V2-P3 1.5 s auto-reset has
    // been retired alongside the SessionEndedSplash.
    sessionStore.getState().markEnded()
    setLogContext({ sess: undefined })
  }
  return () => {
    if (leaveAttempt) return leaveAttempt
    teardownCommitted = false
    const attempt = performLeave().catch((err) => {
      if (!teardownCommitted) {
        sessionStore.getState().clearPendingEndReason('user')
        sessionStore.getState().setRejoinDeadline(null)
        leaveAttempt = null
        throw err
      }
      // Once room teardown has started, replaying this whole stint is not
      // safe. End locally and surface the unexpected failure in diagnostics.
      log.error('session.end_unexpected_failure', { err })
      sessionStore.getState().markEnded()
      setLogContext({ sess: undefined })
    })
    leaveAttempt = attempt
    return attempt
  }
}

type WireHooks = {
  isHost: boolean
  // A guest that joined from a signed inbox envelope binds original-host
  // authority to that envelope's authenticated inviter identity. Undefined
  // preserves the pre-anchor direct-join API for older callers.
  expectedAuthorityEdPubkeyHex?: string | null
  // An original host carries incumbent transport IDs captured before its own
  // Leave into a same-ID rejoin. Until they reconnect (or grace expires),
  // unseen invitees cannot consume their reserved slots.
  reservedReconnectPeerIds?: readonly string[]
  // A guest that locally left after the authenticated original host had
  // already departed carries this frozen roster into its short rejoin window.
  // It is local state, checked again against the signed invite anchor below.
  frozenGuestAdmission?: GuestAdmissionSnapshot | null
  leave: () => Promise<void>
}

export type RoomLifecycle = {
  peers: () => readonly string[]
  // Called only after SessionView validates the peer's signed hello. A guest
  // with a signed inbox invite uses this to bind authority to its inviter.
  authenticateAuthority: (peerId: string, edPubkeyHex: string) => void
  // Room.leave() clears Trystero's peer maps without promising to replay the
  // peer-leave callbacks registered by this lifecycle. Make locally-owned
  // authentication/reservation timers inert before that happens.
  dispose: () => void
  getFrozenGuestAdmission: () => GuestAdmissionSnapshot | null
}

type AdmissionAuthorityPayload = {
  v: 1
  authority_peer_id: string
  admitted_peer_ids: string[]
  roster_revision: number
}

export const ADMISSION_AUTHORITY_ACTION = 'session-admission'
const ADMISSION_CAPABILITY_ACK_ACTION = 'session-admission-ack'

type AdmissionCapabilityAck = { v: 1 }

function isAdmissionCapabilityAck(
  data: unknown
): data is AdmissionCapabilityAck {
  return (
    !!data &&
    typeof data === 'object' &&
    (data as Partial<AdmissionCapabilityAck>).v === 1
  )
}

function isAdmissionAuthorityPayload(
  data: unknown
): data is AdmissionAuthorityPayload {
  if (!data || typeof data !== 'object') return false
  const payload = data as Partial<AdmissionAuthorityPayload>
  return (
    payload.v === 1 &&
    typeof payload.authority_peer_id === 'string' &&
    payload.authority_peer_id.length > 0 &&
    payload.authority_peer_id.length <= 256 &&
    typeof payload.roster_revision === 'number' &&
    Number.isSafeInteger(payload.roster_revision) &&
    payload.roster_revision >= 0 &&
    Array.isArray(payload.admitted_peer_ids) &&
    payload.admitted_peer_ids.length <= MAX_REMOTE_PEERS &&
    payload.admitted_peer_ids.every(
      (peerId) =>
        typeof peerId === 'string' && peerId.length > 0 && peerId.length <= 256
    ) &&
    new Set(payload.admitted_peer_ids).size === payload.admitted_peer_ids.length
  )
}

// A local user who leaves after studying with somebody gets a short recovery
// opportunity. This deadline belongs only to that leaver; it never controls
// the lifetime of a participant who remains in the room.
export const REJOIN_WINDOW_MS = 20_000

// A guest waits only long enough for the original host's data-channel roster
// announcement. Without one it must not form a hostless mesh with another
// unverified invitee, but it also must not let that peer force local teardown.
export const ADMISSION_AUTHENTICATION_TIMEOUT_MS = 3_000
const LEGACY_AUTHORITY_FALLBACK_MS = 350
const MAX_ADMISSION_ROSTER_PROBES = 3

// Wires onPeerJoin / onPeerLeave / 'session-full' on the trystero room. The
// original host is the only admission authority: it announces its stable peer
// id to guests while it is present. When that peer disappears, survivors keep
// studying but fail closed for unseen IDs; an already admitted peer may still
// reconnect. This prevents delayed invitees from becoming admission authority
// and evicting a valid incumbent. If the original host reconnects with its
// same Trystero ID, it reopens admission and resumes the usual 4-user cap.
export function wireSessionRoom(
  room: TopicRoom,
  hooks: WireHooks,
  store: SessionStore = useSessionStore
): RoomLifecycle {
  const peers = new Set<string>()
  // #264 — the live RTCPeerConnection behind each admitted peer, captured at
  // join. The departure path needs it for two things trystero does not give
  // it: the transport state that preceded the departure, and a handle to
  // close a connection trystero abandoned open. Empty for the in-process room
  // mocks used by tests, which is what keeps their departures on the
  // immediate path.
  const transportByPeer = new Map<string, RTCPeerConnection>()
  const reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>()
  // A guest's onPeerJoin only observes transport. The original host's
  // authority-checked roster below is the only source of reconnect eligibility.
  const reconnectPeerIds = new Set<string>()
  const announcedAdmittedPeerIds = new Set<string>()
  const reservedReconnectPeerIds = new Set(
    hooks.isHost
      ? (hooks.reservedReconnectPeerIds ?? []).slice(0, MAX_REMOTE_PEERS)
      : []
  )
  const hostAdmittedPeerIds = new Set(reservedReconnectPeerIds)
  const pendingPeerJoins = new Set<string>()
  const pendingPeerJoinTimers = new Map<string, ReturnType<typeof setTimeout>>()
  // Only meaningful for a signed-invite guest during the short legacy hello
  // grace. It distinguishes a full pre-hello mesh from a merely reordered
  // three-peer join, without admitting or evicting an arbitrary transport.
  let pendingLegacyMeshOverflow = false
  const rejectionFlushTimers = new Map<
    ReturnType<typeof setTimeout>,
    () => void
  >()
  const sessionFull = room.makeAction<null>(SESSION_FULL_ACTION)
  const admissionAuthority = room.makeAction<AdmissionAuthorityPayload>(
    ADMISSION_AUTHORITY_ACTION
  )
  const admissionCapabilityAck = room.makeAction<AdmissionCapabilityAck>(
    ADMISSION_CAPABILITY_ACK_ACTION
  )
  const requiresBoundAuthority =
    !hooks.isHost && hooks.expectedAuthorityEdPubkeyHex != null
  const expectedAuthorityEdPubkeyHex =
    typeof hooks.expectedAuthorityEdPubkeyHex === 'string' &&
    /^[0-9a-f]{64}$/i.test(hooks.expectedAuthorityEdPubkeyHex)
      ? hooks.expectedAuthorityEdPubkeyHex.toLowerCase()
      : ''
  const frozenGuestAdmission =
    !hooks.isHost &&
    hooks.frozenGuestAdmission?.authorityEdPubkeyHex.toLowerCase() ===
      expectedAuthorityEdPubkeyHex &&
    hooks.frozenGuestAdmission.admittedPeerIds.length <= MAX_REMOTE_PEERS
      ? hooks.frozenGuestAdmission
      : null
  let authorityPeerId = hooks.isHost
    ? room.selfId
    : (frozenGuestAdmission?.authorityPeerId ?? null)
  // Trystero may deliver an action as soon as the data channel activates,
  // before this room's onPeerJoin callback. Retain a host announcement only
  // until its named peer actually joins; it cannot make a non-member an
  // authority.
  let pendingAuthorityPeerId: string | null = null
  let admissionsClosed = frozenGuestAdmission !== null
  let nextAuthorityRosterRevision = 0
  let announcedRosterRevision: number | null = null
  let hasAuthenticatedRoster = hooks.isHost || frozenGuestAdmission !== null
  let rejectedByAuthority = false
  let authenticatedAuthorityPeerId: string | null = hooks.isHost
    ? room.selfId
    : null
  // Unlike `authenticatedAuthorityPeerId`, this survives an authority's
  // transport departure solely to serialize a locally verified frozen roster
  // for the current user's short rejoin window. It never authorizes a live
  // session-full or a new entrant.
  let historicallyAuthenticatedAuthorityPeerId: string | null = hooks.isHost
    ? room.selfId
    : (frozenGuestAdmission?.authorityPeerId ?? null)
  const pendingAuthorityAnnouncements = new Map<
    string,
    AdmissionAuthorityPayload
  >()
  const pendingSessionFullPeerIds = new Set<string>()
  let reservationExpiryTimer: ReturnType<typeof setTimeout> | null = null
  let legacyAuthorityFallbackTimer: ReturnType<typeof setTimeout> | null = null
  let disposed = false
  let admissionCapabilityAckInFlight = false
  const rosterCapablePeerIds = new Set<string>()
  const rosterProbeAttempts = new Map<string, number>()
  const rosterProbeRetryTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >()

  if (frozenGuestAdmission) {
    for (const peerId of frozenGuestAdmission.admittedPeerIds) {
      announcedAdmittedPeerIds.add(peerId)
      reconnectPeerIds.add(peerId)
    }
    reconnectPeerIds.add(frozenGuestAdmission.authorityPeerId)
  }

  const dispose = () => {
    if (disposed) return
    disposed = true
    for (const timeout of pendingPeerJoinTimers.values()) {
      clearTimeout(timeout)
    }
    pendingPeerJoinTimers.clear()
    pendingPeerJoins.clear()
    if (reservationExpiryTimer !== null) {
      clearTimeout(reservationExpiryTimer)
      reservationExpiryTimer = null
    }
    if (legacyAuthorityFallbackTimer !== null) {
      clearTimeout(legacyAuthorityFallbackTimer)
      legacyAuthorityFallbackTimer = null
    }
    for (const [timeout, finish] of rejectionFlushTimers) {
      clearTimeout(timeout)
      finish()
    }
    rejectionFlushTimers.clear()
    pendingAuthorityAnnouncements.clear()
    pendingSessionFullPeerIds.clear()
    for (const timeout of rosterProbeRetryTimers.values()) {
      clearTimeout(timeout)
    }
    rosterProbeRetryTimers.clear()
    rosterProbeAttempts.clear()
    for (const [peerId, timeout] of reconnectTimers) {
      clearTimeout(timeout)
      store.getState().peerReconnectExpired(peerId)
    }
    reconnectTimers.clear()
    transportByPeer.clear()
  }

  // trystero publishes a peer into its active map immediately before firing
  // onPeerJoin, so the connection is always resolvable here.
  const bindTransport = (peerId: string) => {
    const connection = room.getPeers()[peerId]
    if (connection) transportByPeer.set(peerId, connection)
  }

  const scheduleReconnectGrace = (peerId: string) => {
    const existing = reconnectTimers.get(peerId)
    if (existing !== undefined) clearTimeout(existing)
    reconnectTimers.set(
      peerId,
      setTimeout(() => {
        reconnectTimers.delete(peerId)
        if (disposed) return
        store.getState().peerReconnectExpired(peerId)
        log.info('peer.reconnect_expired', {
          role: hooks.isHost ? 'host' : 'guest',
          graceMs: PEER_RECONNECT_GRACE_MS,
          peerCount: peers.size,
        })
      }, PEER_RECONNECT_GRACE_MS)
    )
  }

  const closeOrphanedTransport = (
    connection: RTCPeerConnection | undefined
  ) => {
    if (!connection || connection.connectionState === 'closed') return
    try {
      closeTransport(connection)
      log.info('transport.closed_orphan', {
        role: hooks.isHost ? 'host' : 'guest',
        peerCount: peers.size,
      })
    } catch (err) {
      // The in-process bus used by tests intentionally has only a no-op close.
      log.warn('transport.close_orphan_failed', { err })
    }
  }

  const clearReconnectGrace = (peerId: string): boolean => {
    const timeout = reconnectTimers.get(peerId)
    if (timeout === undefined) return false
    clearTimeout(timeout)
    reconnectTimers.delete(peerId)
    return true
  }

  const getFrozenGuestAdmission = (): GuestAdmissionSnapshot | null => {
    if (
      hooks.isHost ||
      !requiresBoundAuthority ||
      authorityPeerId === null ||
      historicallyAuthenticatedAuthorityPeerId !== authorityPeerId
    ) {
      return null
    }
    const admittedPeerIds = hasAuthenticatedRoster
      ? Array.from(announcedAdmittedPeerIds).filter(
          (peerId) => peerId !== authorityPeerId
        )
      : Array.from(
          new Set([
            room.selfId,
            ...Array.from(peers).filter((id) => id !== authorityPeerId),
          ])
        )
    if (!admittedPeerIds.includes(room.selfId)) return null
    return {
      authorityPeerId,
      authorityEdPubkeyHex: expectedAuthorityEdPubkeyHex,
      admittedPeerIds: admittedPeerIds.slice(0, MAX_REMOTE_PEERS),
    }
  }

  const closePeerTransport = (peerId: string) => {
    if (disposed) return
    try {
      // Channels first (see closeTransport): an evicted peer learns from a
      // stream reset instead of waiting out ICE consent.
      closeTransport(room.getPeers()[peerId])
    } catch {
      // The in-process bus used by tests intentionally has only a no-op close.
    }
  }

  const closePeersExcludedByRoster = (allowedPeerIds: ReadonlySet<string>) => {
    if (hooks.isHost) return
    for (const peerId of peers) {
      if (peerId !== authorityPeerId && !allowedPeerIds.has(peerId)) {
        // Do not mutate `peers` or the session store here. Trystero owns the
        // transport lifecycle and will deliver the idempotent onPeerLeave
        // callback after close; doing it eagerly would double-close presence.
        closePeerTransport(peerId)
      }
    }
  }

  const clearPendingPeerJoin = (peerId: string) => {
    pendingPeerJoins.delete(peerId)
    const timeout = pendingPeerJoinTimers.get(peerId)
    if (timeout !== undefined) {
      clearTimeout(timeout)
      pendingPeerJoinTimers.delete(peerId)
    }
  }

  const queuePendingPeerJoin = (peerId: string) => {
    if (disposed || pendingPeerJoins.has(peerId) || peers.has(peerId)) return
    if (pendingPeerJoins.size >= MAX_REMOTE_PEERS) {
      if (requiresBoundAuthority && !hasAuthenticatedRoster) {
        pendingLegacyMeshOverflow = true
      }
      rejectPeer(peerId, 'closed')
      return
    }
    pendingPeerJoins.add(peerId)
    pendingPeerJoinTimers.set(
      peerId,
      setTimeout(() => {
        if (disposed || !pendingPeerJoins.has(peerId)) return
        clearPendingPeerJoin(peerId)
        rejectPeer(peerId, 'closed')
        // Before an authority has supplied a roster, this local join attempt
        // has no safe mesh to remain in. Once an authenticated roster exists,
        // however, an unknown candidate must never tear down an incumbent.
        if (
          !hasAuthenticatedRoster &&
          (authorityPeerId === null ||
            authenticatedAuthorityPeerId !== authorityPeerId)
        ) {
          endRejectedGuest('timeout')
        }
      }, ADMISSION_AUTHENTICATION_TIMEOUT_MS)
    )
  }

  const resolvePendingPeerJoin = (peerId: string) => {
    if (disposed) return
    if (!pendingPeerJoins.has(peerId)) return
    clearPendingPeerJoin(peerId)
    completePeerJoin(peerId)
  }

  const endRejectedGuest = (reason: 'authority' | 'timeout') => {
    if (disposed || hooks.isHost || rejectedByAuthority) return
    rejectedByAuthority = true
    log.warn('session_admission.guest_rejected', { reason })
    toast.error(SESSION_FULL_MESSAGE)
    store.getState().setPendingEndReason('peer')
    void hooks.leave().catch((err) => {
      log.warn('session_admission.guest_leave_failed', { reason, err })
    })
  }

  const clearExpiredReservations = () => {
    reservationExpiryTimer = null
    if (disposed) return
    for (const peerId of reservedReconnectPeerIds) {
      hostAdmittedPeerIds.delete(peerId)
    }
    reservedReconnectPeerIds.clear()
    if (hooks.isHost) {
      void announceAdmissionRoster().catch((err) => {
        log.warn('session_admission.announce_failed', { err })
      })
    }
  }
  if (reservedReconnectPeerIds.size > 0) {
    reservationExpiryTimer = setTimeout(
      clearExpiredReservations,
      REJOIN_WINDOW_MS
    )
  }

  sessionFull.receive((_, senderPeerId) => {
    if (disposed) return
    // A normal participant never gets to evict another one. A rejected guest
    // may accept the original host's targeted notice while its preceding
    // authority announcement is still pending on the join callback.
    const senderIsAuthority = requiresBoundAuthority
      ? senderPeerId === authenticatedAuthorityPeerId
      : senderPeerId === authorityPeerId ||
        senderPeerId === pendingAuthorityPeerId
    // Session termination is authority-checked, not cryptographically signed:
    // only the announced original host (or its in-flight announcement) can
    // end a guest. A host never accepts remote termination.
    if (hooks.isHost) {
      return
    }
    if (!senderIsAuthority) {
      // An origin/main host may reject before its signed hello reaches this
      // client. Remember a few candidate notices, but consume one only after
      // the existing hello verification binds that exact sender to the invite.
      if (
        requiresBoundAuthority &&
        pendingSessionFullPeerIds.size < MAX_REMOTE_PEERS + 1
      ) {
        pendingSessionFullPeerIds.add(senderPeerId)
      }
      return
    }
    log.warn('session_full.received', { role: hooks.isHost ? 'host' : 'guest' })
    toast.error(SESSION_FULL_MESSAGE)
    store.getState().setPendingEndReason('peer')
    void hooks.leave().catch((err) => {
      // Leave deliberately persists end state even if the underlying room's
      // departure broadcast fails. Do not turn that expected failure into an
      // unhandled action callback rejection.
      log.warn('session_full.leave_failed', { err })
    })
  })

  const rejectPeer = (peerId: string, reason: 'full' | 'closed') => {
    if (disposed) return
    log.warn('session_admission.rejected_peer', {
      role: hooks.isHost ? 'host' : 'guest',
      reason,
      peerCount: peers.size,
    })
    // Only the original host may ask a client to end. Hostless survivors
    // instead close the unknown transport; this is intentionally enough to
    // preserve their bounded mesh without reintroducing forged eviction.
    if (hooks.isHost) {
      void (async () => {
        try {
          // Broadcast the current roster before the targeted termination so
          // incumbent guests also close this peer if its leave callback races
          // the original host's own departure.
          await announceAdmissionRoster(peerId)
        } catch (err) {
          log.warn('session_admission.reject_roster_failed', { err })
        }
        try {
          await sessionFull.send(null, peerId)
        } catch (err) {
          log.warn('session_admission.reject_notice_failed', { err })
        } finally {
          // Action sends enqueue data before resolving. Keep the transport
          // alive for the same bounded window Trystero normally used so the
          // roster (which makes a rejected guest leave itself) can flush.
          await new Promise<void>((resolve) => {
            const timeout = setTimeout(() => {
              rejectionFlushTimers.delete(timeout)
              resolve()
            }, 99)
            const finish = () => {
              rejectionFlushTimers.delete(timeout)
              resolve()
            }
            rejectionFlushTimers.set(timeout, finish)
          })
          if (!disposed) closePeerTransport(peerId)
        }
      })()
      return
    }
    closePeerTransport(peerId)
  }

  const announceAdmissionRoster = (targetPeerId?: string) => {
    if (disposed || !hooks.isHost) return Promise.resolve()
    const rosterRevision = nextAuthorityRosterRevision
    nextAuthorityRosterRevision += 1
    const payload = {
      v: 1 as const,
      authority_peer_id: room.selfId,
      admitted_peer_ids: Array.from(hostAdmittedPeerIds).sort(),
      roster_revision: rosterRevision,
    }
    // Older guests have no receiver for session-admission. The patched action
    // wire deliberately queues unknown actions only up to a hard limit, so a
    // broadcast on every churn would disconnect an otherwise valid legacy
    // client. Probe a freshly admitted transport exactly once; thereafter
    // publish updates only to peers that explicitly ACK this capability.
    const targets = targetPeerId
      ? [targetPeerId]
      : Array.from(rosterCapablePeerIds)
    return Promise.all(
      targets.map((peerId) => admissionAuthority.send(payload, peerId))
    ).then(() => undefined)
  }

  const clearRosterProbe = (peerId: string) => {
    const timeout = rosterProbeRetryTimers.get(peerId)
    if (timeout !== undefined) clearTimeout(timeout)
    rosterProbeRetryTimers.delete(peerId)
    rosterProbeAttempts.delete(peerId)
  }

  const probeAdmissionRoster = (peerId: string) => {
    if (disposed || !hooks.isHost || !hostAdmittedPeerIds.has(peerId)) return
    const attempt = (rosterProbeAttempts.get(peerId) ?? 0) + 1
    rosterProbeAttempts.set(peerId, attempt)
    // Queue success is not delivery proof. Keep a tiny, targeted probe window
    // until a modern guest ACKs; a legacy peer sees three unknown actions at
    // most, safely below action-wire's 64-message containment limit.
    void announceAdmissionRoster(peerId)
      .catch((err) => {
        log.warn('session_admission.probe_failed', { peerId, attempt, err })
      })
      .finally(() => {
        if (
          attempt >= MAX_ADMISSION_ROSTER_PROBES ||
          disposed ||
          rosterCapablePeerIds.has(peerId)
        ) {
          return
        }
        rosterProbeRetryTimers.set(
          peerId,
          setTimeout(() => {
            rosterProbeRetryTimers.delete(peerId)
            probeAdmissionRoster(peerId)
          }, 100)
        )
      })
  }

  const completePeerJoin = (peerId: string) => {
    if (disposed) return
    if (peers.has(peerId)) return
    if (
      (admissionsClosed && !reconnectPeerIds.has(peerId)) ||
      (hooks.isHost &&
        reservedReconnectPeerIds.size > 0 &&
        !reservedReconnectPeerIds.has(peerId))
    ) {
      rejectPeer(peerId, 'closed')
      return
    }
    // Once a modern, authenticated roster exists, data-channel membership is
    // not admission. Keep a possibly rejected fifth provisional until the
    // original host's roster explicitly names it; a lost/reordered rejection
    // packet or host departure cannot otherwise strand it in an incumbent
    // mesh. Legacy hosts never set this bit and retain their hello fallback.
    if (
      !hooks.isHost &&
      hasAuthenticatedRoster &&
      peerId !== authorityPeerId &&
      peerId !== pendingAuthorityPeerId &&
      !announcedAdmittedPeerIds.has(peerId)
    ) {
      queuePendingPeerJoin(peerId)
      return
    }
    // A legacy/origin-main authority has no roster updates. Once its bounded
    // mesh is stabilized, preserve all incumbent connections and locally
    // reject later transports rather than depending on an old session-full
    // packet to survive every ordering race.
    if (
      !hooks.isHost &&
      !hasAuthenticatedRoster &&
      peers.size >= MAX_REMOTE_PEERS
    ) {
      rejectPeer(peerId, 'full')
      return
    }
    // Only the original host makes the capacity decision while admission is
    // open. A prospective fifth participant can transiently see all four
    // incumbents in Trystero's mesh; letting that entrant reject its fourth
    // remote peer would evict a valid member before the host rejects it.
    if (hooks.isHost && peers.size >= MAX_REMOTE_PEERS) {
      rejectPeer(peerId, 'full')
      return
    }
    peers.add(peerId)
    bindTransport(peerId)
    const reconnected = clearReconnectGrace(peerId)
    if (hooks.isHost) {
      hostAdmittedPeerIds.add(peerId)
      reservedReconnectPeerIds.delete(peerId)
    }
    if (pendingAuthorityPeerId === peerId) {
      authorityPeerId = peerId
      pendingAuthorityPeerId = null
    }
    if (
      admissionsClosed &&
      peerId === authorityPeerId &&
      (!requiresBoundAuthority || authenticatedAuthorityPeerId === peerId)
    ) {
      admissionsClosed = false
      log.info('session_admission.authority_reconnected', {
        role: hooks.isHost ? 'host' : 'guest',
      })
    }
    store.getState().peerJoined(peerId)
    const rosterUpdate = hooks.isHost
      ? Promise.all([
          // One bounded compatibility probe for the arriving peer.
          Promise.resolve(probeAdmissionRoster(peerId)),
          // Existing modern peers need the new incumbent in their frozen
          // roster if the authority disappears next; legacy peers are absent
          // from rosterCapablePeerIds and receive nothing here.
          announceAdmissionRoster(),
        ])
      : announceAdmissionRoster()
    void rosterUpdate.catch((err) => {
      log.warn('session_admission.announce_failed', { err })
    })
    log.info('peer.joined', {
      role: hooks.isHost ? 'host' : 'guest',
      peerCount: peers.size,
      // #264 — true when this join resumed a tile the grace window was
      // holding open, rather than admitting a newly arrived participant.
      reconnected,
    })
  }

  const applyAuthorityAnnouncement = (
    data: AdmissionAuthorityPayload,
    senderPeerId: string
  ) => {
    if (disposed) return
    if (legacyAuthorityFallbackTimer !== null) {
      clearTimeout(legacyAuthorityFallbackTimer)
      legacyAuthorityFallbackTimer = null
    }
    // The original host is not transferable. Once established, its stable
    // transport ID stays authoritative until that same ID reconnects.
    if (
      data.authority_peer_id !== senderPeerId ||
      (authorityPeerId !== null && authorityPeerId !== senderPeerId)
    ) {
      return
    }
    const acceptRoster = () => {
      if (
        announcedRosterRevision !== null &&
        data.roster_revision < announcedRosterRevision
      ) {
        return false
      }
      announcedAdmittedPeerIds.clear()
      for (const admittedPeerId of data.admitted_peer_ids) {
        announcedAdmittedPeerIds.add(admittedPeerId)
      }
      announcedRosterRevision = data.roster_revision
      hasAuthenticatedRoster = true
      if (
        requiresBoundAuthority &&
        !announcedAdmittedPeerIds.has(room.selfId)
      ) {
        // An authority-authenticated roster is sufficient rejection proof.
        // Do not depend on a subsequent session-full action surviving a
        // teardown race after its bytes have merely been queued.
        endRejectedGuest('authority')
        return false
      }
      closePeersExcludedByRoster(announcedAdmittedPeerIds)
      if (!hooks.isHost && !admissionCapabilityAckInFlight) {
        admissionCapabilityAckInFlight = true
        void admissionCapabilityAck
          .send({ v: 1 }, senderPeerId)
          .catch((err) => {
            log.warn('session_admission.capability_ack_failed', { err })
          })
          .finally(() => {
            admissionCapabilityAckInFlight = false
          })
      }
      for (const pendingPeerId of Array.from(pendingPeerJoins)) {
        if (
          pendingPeerId === senderPeerId ||
          announcedAdmittedPeerIds.has(pendingPeerId)
        ) {
          resolvePendingPeerJoin(pendingPeerId)
        }
      }
      return true
    }
    if (peers.has(senderPeerId)) {
      authorityPeerId = data.authority_peer_id
      if (!acceptRoster()) return
      if (
        admissionsClosed &&
        (!requiresBoundAuthority ||
          authenticatedAuthorityPeerId === senderPeerId)
      ) {
        admissionsClosed = false
        log.info('session_admission.authority_reconnected', {
          role: hooks.isHost ? 'host' : 'guest',
        })
      }
      return
    }
    // After the original host disappears, only its known peer ID may reopen
    // admission from onPeerJoin. A delayed entrant's early action must not
    // queue a claim that later turns it into an authority.
    if (admissionsClosed) return
    pendingAuthorityPeerId = data.authority_peer_id
    acceptRoster()
  }

  admissionAuthority.receive((data, senderPeerId) => {
    if (disposed) return
    if (!isAdmissionAuthorityPayload(data)) return
    if (
      data.authority_peer_id !== senderPeerId ||
      (authorityPeerId !== null && authorityPeerId !== senderPeerId)
    ) {
      return
    }
    if (
      requiresBoundAuthority &&
      authenticatedAuthorityPeerId !== senderPeerId
    ) {
      // SessionView owns hello signature validation. Keep one bounded roster
      // until it reports the signed inviter binding through this lifecycle.
      // Preserve each candidate independently: an attacker's later action
      // must not overwrite the original inviter's buffered roster before its
      // signed hello arrives. Candidate peers are transport-bounded; retain a
      // small hard cap as a malformed-room backstop.
      if (
        pendingAuthorityAnnouncements.has(senderPeerId) ||
        pendingAuthorityAnnouncements.size < MAX_REMOTE_PEERS + 1
      ) {
        pendingAuthorityAnnouncements.set(senderPeerId, data)
      }
      return
    }
    applyAuthorityAnnouncement(data, senderPeerId)
  })

  admissionCapabilityAck.receive((data, senderPeerId) => {
    if (
      disposed ||
      !hooks.isHost ||
      !isAdmissionCapabilityAck(data) ||
      !hostAdmittedPeerIds.has(senderPeerId)
    ) {
      return
    }
    const wasCapable = rosterCapablePeerIds.has(senderPeerId)
    rosterCapablePeerIds.add(senderPeerId)
    clearRosterProbe(senderPeerId)
    if (!wasCapable) {
      // An arrival may have raced before its ACK reached the host. A fresh,
      // targeted catch-up roster closes that gap without exposing legacy peers
      // to repeated unknown actions.
      probeAdmissionRoster(senderPeerId)
    }
  })

  const authenticateAuthority = (peerId: string, edPubkeyHex: string) => {
    if (disposed || hooks.isHost || !requiresBoundAuthority) return
    if (edPubkeyHex.toLowerCase() !== expectedAuthorityEdPubkeyHex) return
    if (authorityPeerId !== null && authorityPeerId !== peerId) return
    if (authenticatedAuthorityPeerId === peerId) return
    // The verified inviter identity fixes the original host transport before
    // its roster/onPeerJoin ordering resolves. It is not admission by itself.
    authorityPeerId = peerId
    authenticatedAuthorityPeerId = peerId
    historicallyAuthenticatedAuthorityPeerId = peerId
    if (pendingSessionFullPeerIds.delete(peerId)) {
      endRejectedGuest('authority')
      return
    }
    const pending = pendingAuthorityAnnouncements.get(peerId)
    if (pending) {
      if (legacyAuthorityFallbackTimer !== null) {
        clearTimeout(legacyAuthorityFallbackTimer)
        legacyAuthorityFallbackTimer = null
      }
      pendingAuthorityAnnouncements.delete(peerId)
      applyAuthorityAnnouncement(pending, peerId)
      return
    }
    // A frozen guest snapshot is already an authenticated roster from the
    // preceding room. The original host may rejoin before or after its signed
    // hello; once both identity and membership are present it alone can reopen
    // admission. New peers still need a fresh roster inclusion below.
    if (
      hasAuthenticatedRoster &&
      admissionsClosed &&
      authorityPeerId === peerId &&
      peers.has(peerId)
    ) {
      admissionsClosed = false
      log.info('session_admission.authority_reconnected', {
        role: hooks.isHost ? 'host' : 'guest',
      })
      return
    }
    // origin/main sends the existing signed hello but not an admission roster.
    // Keep that interoperable only for the identity named by the signed inbox
    // envelope; it can establish the original host but cannot transfer it.
    if (authorityPeerId !== null && authorityPeerId !== peerId) return
    // A current host's initial modern roster can be queued then silently lost.
    // Give its bounded targeted probes time to arrive before treating this as
    // a legacy/origin-main host; otherwise a full-room rejection could briefly
    // promote history through the legacy compatibility path.
    legacyAuthorityFallbackTimer = setTimeout(() => {
      legacyAuthorityFallbackTimer = null
      if (
        disposed ||
        authenticatedAuthorityPeerId !== peerId ||
        hasAuthenticatedRoster
      ) {
        return
      }
      pendingAuthorityPeerId = peerId
      // A valid legacy joiner sees at most host + two other remotes. Seeing a
      // fourth pending transport proves that this local client is the fifth;
      // reject itself instead of evicting whichever incumbent happened to be
      // delivered last by the transport callbacks.
      if (
        pendingLegacyMeshOverflow ||
        peers.size + pendingPeerJoins.size > MAX_REMOTE_PEERS
      ) {
        endRejectedGuest('authority')
        return
      }
      // A legacy/origin-main host sends the signed hello but no roster. Its
      // immutable signed identity is sufficient to stabilize the already
      // connected bounded mesh; modern rosters remain authoritative whenever
      // they exist.
      resolvePendingPeerJoin(peerId)
      for (const pendingPeerId of Array.from(pendingPeerJoins)) {
        if (peers.size >= MAX_REMOTE_PEERS) {
          clearPendingPeerJoin(pendingPeerId)
          rejectPeer(pendingPeerId, 'full')
          continue
        }
        resolvePendingPeerJoin(pendingPeerId)
      }
      if (admissionsClosed && authorityPeerId === peerId) {
        admissionsClosed = false
        log.info('session_admission.authority_reconnected', {
          role: hooks.isHost ? 'host' : 'guest',
        })
      }
    }, LEGACY_AUTHORITY_FALLBACK_MS)
  }

  room.onPeerJoin((peerId) => {
    if (disposed) return
    if (peers.has(peerId) || pendingPeerJoins.has(peerId)) return
    if (admissionsClosed && !reconnectPeerIds.has(peerId)) {
      rejectPeer(peerId, 'closed')
      return
    }
    if (!hooks.isHost && authenticatedAuthorityPeerId === peerId) {
      if (!hasAuthenticatedRoster && !admissionsClosed) {
        // Hello can arrive before onPeerJoin. Do not promote a modern host
        // solely from its identity: wait for its buffered roster or the
        // bounded legacy fallback so a self-excluding full-room roster cannot
        // leave provisional hello history behind.
        queuePendingPeerJoin(peerId)
        return
      }
      pendingAuthorityPeerId = peerId
      completePeerJoin(peerId)
      return
    }
    if (
      !hooks.isHost &&
      hasAuthenticatedRoster &&
      peerId !== authorityPeerId &&
      peerId !== pendingAuthorityPeerId &&
      !announcedAdmittedPeerIds.has(peerId)
    ) {
      queuePendingPeerJoin(peerId)
      return
    }
    if (
      !hooks.isHost &&
      !admissionsClosed &&
      authorityPeerId === null &&
      pendingAuthorityPeerId === null
    ) {
      queuePendingPeerJoin(peerId)
      return
    }
    completePeerJoin(peerId)
  })

  room.onPeerLeave((peerId) => {
    if (disposed) return
    // A capacity-rejected transport need not be in either membership set.
    // Always drop its pre-hello candidates so repeated throwaway IDs cannot
    // exhaust the bounded real-host roster buffer.
    pendingAuthorityAnnouncements.delete(peerId)
    pendingSessionFullPeerIds.delete(peerId)
    clearRosterProbe(peerId)
    if (pendingPeerJoins.has(peerId)) {
      clearPendingPeerJoin(peerId)
      if (authorityPeerId === peerId) {
        authenticatedAuthorityPeerId = null
        admissionCapabilityAckInFlight = false
        reconnectPeerIds.clear()
        // A signed legacy hello establishes who could admit us, not that it
        // did. If that host disappears before its bounded compatibility grace
        // completes, partial callback ordering can hide an incumbent and make
        // this client the fifth. Fail this local attempt closed rather than
        // promote a hostless provisional mesh.
        if (!hasAuthenticatedRoster) {
          if (legacyAuthorityFallbackTimer !== null) {
            clearTimeout(legacyAuthorityFallbackTimer)
            legacyAuthorityFallbackTimer = null
          }
          endRejectedGuest('authority')
          return
        }
      }
      return
    }
    if (!peers.has(peerId)) return
    const lostAdmissionAuthority = authorityPeerId === peerId
    peers.delete(peerId)
    if (hooks.isHost) {
      const removed = hostAdmittedPeerIds.delete(peerId)
      reservedReconnectPeerIds.delete(peerId)
      rosterCapablePeerIds.delete(peerId)
      clearRosterProbe(peerId)
      if (removed) {
        void announceAdmissionRoster().catch((err) => {
          log.warn('session_admission.announce_failed', { err })
        })
      }
    }
    // #264 — tell a clean departure from a lost link. A remote Leave arrives
    // over the data channel and a remote quit closes that channel, so both
    // reach us with the transport still 'connected'; only a link that had
    // already gone 'disconnected' or 'failed' is worth waiting on. The
    // instantaneous state cannot answer this — trystero declares the peer
    // gone without closing the connection, which may by now have recovered to
    // 'connected' — hence the last state captured while it was live.
    const transport = transportByPeer.get(peerId)
    const health = transportHealthOf(transport)
    transportByPeer.delete(peerId)
    const lastConnectionState = health?.lastLiveConnectionState ?? null
    const degradedForMs =
      health?.degradedSinceMs != null
        ? Date.now() - health.degradedSinceMs
        : null
    const awaitingReconnect =
      lastConnectionState === 'disconnected' || lastConnectionState === 'failed'
    // #264 — trystero abandons the connection OPEN on an unclean close. Its
    // `SharedPeerManager.clear(…, {destroyPeer: false})` empties `bindings`
    // BEFORE firing each binding's close handler, so the `detachBinding` that
    // would have removed our senders early-returns and never runs. The camera
    // and screen therefore keep transmitting to a peer this app has just told
    // the user is gone — measured, not inferred: with this close removed, the
    // far side decodes 31 fresh frames of us in 4 s while our own session sits
    // empty, which is exactly what #264's reporter described.
    //
    // The far side is also stuck: its `state.connectedPeer` still points at
    // this connection, `getConnectedPeerHealth` reads it as "live" because
    // its data channel never closed, and `createSignalHandler` returns early
    // on precisely that, so it drops every offer we send. Nothing we do
    // locally re-forms the session while this connection stays up. Closing it
    // — data channels first, so they learn from a stream reset instead of
    // waiting out ICE consent — is what unblocks the grace window below;
    // measured, reconnection then lands inside it.
    //
    // Never on a clean departure: a peer who leaves the session by choice is
    // still a friend, and presence and the inbox go on riding that same
    // connection. The one case this gets wrong is a Leave that arrives while
    // the link is degraded — then presence and the inbox re-establish, which
    // the 60 s heartbeat window absorbs invisibly. Staying on camera to
    // someone the UI says has gone is the worse failure.
    if (awaitingReconnect) closeOrphanedTransport(transport)
    // Presence closes at the drop either way. The grace window holds only the
    // tile, so ending the session mid-grace cannot inflate measured overlap.
    const closedPresence = awaitingReconnect
      ? store.getState().peerTransportLost(peerId)
      : store.getState().peerLeft(peerId)
    if (closedPresence) {
      void useFriendsStore
        .getState()
        .markStudiedAt([
          {
            edPubkey: closedPresence.edPubkeyHex,
            ts: closedPresence.endedAt,
          },
        ])
        .catch((err) => {
          log.error('mark_studied.failed', {
            peerCount: 1,
            phase: 'peer-left',
            err,
          })
        })
    }
    if (awaitingReconnect) scheduleReconnectGrace(peerId)
    log.info('peer.left', {
      role: hooks.isHost ? 'host' : 'guest',
      peerCount: peers.size,
      presenceClosed: closedPresence !== null,
      // #264 diagnostics: an empty "Anything from the logs" box on the issue
      // was the direct consequence of recording nothing about the transport.
      lastConnectionState,
      degradedForMs,
      awaitingReconnect,
    })
    if (lostAdmissionAuthority) {
      authenticatedAuthorityPeerId = hooks.isHost ? room.selfId : null
      // A same-ID host rejoin creates a fresh room lifecycle and a fresh
      // capability registry on the host. Its next authenticated roster needs
      // a new ACK from this guest before it can receive later churn updates.
      admissionCapabilityAckInFlight = false
      pendingAuthorityAnnouncements.delete(peerId)
      reconnectPeerIds.clear()
      if (hasAuthenticatedRoster) {
        for (const admittedPeerId of announcedAdmittedPeerIds) {
          reconnectPeerIds.add(admittedPeerId)
        }
      } else {
        for (const incumbentPeerId of peers) {
          reconnectPeerIds.add(incumbentPeerId)
        }
      }
      reconnectPeerIds.add(peerId)
      // A same-ID original-host reconnect starts a fresh room lifecycle and
      // therefore restarts its revision counter. Forget this departed
      // authority's revision while retaining its frozen roster.
      announcedRosterRevision = null
      admissionsClosed = true
      // A modern host's frozen roster decides which still-provisional
      // transports may survive its departure. Close excluded candidates now
      // so a rejected fifth cannot retain a live mesh edge for its timeout.
      for (const candidatePeerId of Array.from(pendingPeerJoins)) {
        if (!reconnectPeerIds.has(candidatePeerId)) {
          clearPendingPeerJoin(candidatePeerId)
          rejectPeer(candidatePeerId, 'closed')
        }
      }
      // A host-rejected entrant can be briefly present in a guest's transport
      // mesh when the host itself disappears. The last authoritative roster
      // excludes it, so actively close it instead of letting it survive until
      // an arbitrary future peer callback.
      closePeersExcludedByRoster(reconnectPeerIds)
      log.warn('session_admission.authority_lost', {
        role: hooks.isHost ? 'host' : 'guest',
      })
    }
  })

  return {
    peers: () => Array.from(peers),
    authenticateAuthority,
    dispose,
    getFrozenGuestAdmission,
  }
}
