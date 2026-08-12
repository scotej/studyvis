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
import { buildIceOptions } from '@/lib/trystero/ice'
import { userRelayConfig } from '@/lib/trystero/relays'
import { useAuditStore } from '@/stores/auditStore'
import { useFriendsStore } from '@/stores/friendsStore'
import { useSessionStore, type SessionStore } from '@/stores/sessionStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { strings } from '@/strings'
import { flushLog, logger, setLogContext } from '@/lib/log'

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
  leave: () => Promise<void>
}

export type RoomLifecycle = {
  peers: () => readonly string[]
}

// A local user who leaves after studying with somebody gets a short recovery
// opportunity. This deadline belongs only to that leaver; it never controls
// the lifetime of a participant who remains in the room.
export const REJOIN_WINDOW_MS = 20_000

// Wires onPeerJoin / onPeerLeave / 'session-full' on the trystero room. The
// host enforces the 4-user cap here (rejects the 4th remote peer); guests
// listen for 'session-full' and tear down with a toast. Remote peer changes
// only change membership: zero peers is a valid active solo session.
export function wireSessionRoom(
  room: TopicRoom,
  hooks: WireHooks,
  store: SessionStore = useSessionStore
): RoomLifecycle {
  const peers = new Set<string>()
  const sessionFull = room.makeAction<null>(SESSION_FULL_ACTION)

  if (!hooks.isHost) {
    sessionFull.receive(() => {
      log.warn('session_full.received', { role: 'guest' })
      toast.error(SESSION_FULL_MESSAGE)
      store.getState().setPendingEndReason('peer')
      void hooks.leave()
    })
  }

  room.onPeerJoin((peerId) => {
    if (peers.has(peerId)) return
    if (hooks.isHost && peers.size >= MAX_REMOTE_PEERS) {
      log.warn('session_full.rejected_peer', {
        role: 'host',
        peerCount: peers.size,
      })
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
    store.getState().peerJoined(peerId)
    log.info('peer.joined', {
      role: hooks.isHost ? 'host' : 'guest',
      peerCount: peers.size,
    })
  })

  room.onPeerLeave((peerId) => {
    if (!peers.has(peerId)) return
    peers.delete(peerId)
    const closedPresence = store.getState().peerLeft(peerId)
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
    log.info('peer.left', {
      role: hooks.isHost ? 'host' : 'guest',
      peerCount: peers.size,
      presenceClosed: closedPresence !== null,
    })
  })

  return {
    peers: () => Array.from(peers),
  }
}
