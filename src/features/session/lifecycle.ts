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
import { bytesToBase64 } from '@/lib/encoding'
import { joinTopic, type TopicRoom } from '@/lib/trystero'
import { buildIceOptions } from '@/lib/trystero/ice'
import { userRelayConfig } from '@/lib/trystero/relays'
import { useAuditStore } from '@/stores/auditStore'
import { useFriendsStore } from '@/stores/friendsStore'
import { useSessionStore } from '@/stores/sessionStore'
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
  // trystero assembles this string around remote peer data, so it is
  // untrusted text — the logger sanitises it on the way in.
  log.warn('join.error', { room: 'session', joinError: details.error })
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
// of peers. Focus score/tallies continue in memory across a rejoin, so this
// second upsert carries metrics for the whole logical session too.
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
    const endReason = sessionState.pendingEndReason ?? 'user'
    const rejoinable =
      sessionState.hadAnyPeer && (endReason === 'auto' || endReason === 'user')
    sessionState.setRejoinDeadline(
      rejoinable ? endedAt + DISCONNECT_GRACE_MS : null
    )
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

    log.info('session.end_started', {
      role: sessionState.isHost ? 'host' : 'guest',
      endReason,
      livePeerCount: Object.keys(sessionState.peers).length,
      seenPeerCount: peerEdPubkeys.length,
      hadAnyPeer: sessionState.hadAnyPeer,
      wallMs,
      awakeMs: monoMs,
    })

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

    const stint = { startedAt: args.startedAt, totalMinutes, peerPubkeys }
    const buildSessionRow = (
      summary: typeof stint,
      focus: PersistedFocusMetrics,
      replaceFocusMetrics: boolean
    ): SessionRow => ({
      id: args.topic,
      startedAt: summary.startedAt,
      endedAt,
      totalMinutes: summary.totalMinutes,
      peerPubkeys: summary.peerPubkeys,
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
    let merged = stint
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
      await useFriendsStore.getState().markStudied(peerEdPubkeys, endedAt)
      friendsUpdated = true
      log.debug('mark_studied.succeeded', {
        peerCount: peerEdPubkeys.length,
      })
    } catch (err) {
      log.error('mark_studied.failed', { peerCount: peerEdPubkeys.length, err })
    }
    log.info('session.end_completed', {
      endReason,
      rejoinDeadline: rejoinable ? endedAt + DISCONNECT_GRACE_MS : null,
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
    await flushLog()
    // Flip to 'ended'. The Report view (mounted by Home.tsx when status ===
    // 'ended') queries the just-persisted sessions row + audit_events for
    // this topic. Reset of audit + pomodoro stores is driven by the V2-P5
    // reset effect in SessionView the next time a session begins (handles
    // the invite-while-on-report path); the V2-P3 1.5 s auto-reset has
    // been retired alongside the SessionEndedSplash.
    useSessionStore.getState().markEnded()
    setLogContext({ sess: undefined })
  }
}

type WireHooks = {
  isHost: boolean
  leave: () => Promise<void>
}

export type RoomLifecycle = {
  peers: () => readonly string[]
}

// S1 / #190 — grace window before the everyone-else-left auto-end fires. A
// WiFi blip or an accidental Leave can drop the transport to every peer at
// once; without a debounce either event irreversibly ends a long session. We
// arm a timer whenever the room empties and only run the leave handler if it is
// STILL empty when the timer expires.
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
// was present, including after a signed deliberate Leave.
export function wireSessionRoom(
  room: TopicRoom,
  hooks: WireHooks,
  options?: { scheduler?: GraceScheduler; graceMs?: number }
): RoomLifecycle {
  const scheduler = options?.scheduler ?? defaultGraceScheduler
  const graceMs = options?.graceMs ?? DISCONNECT_GRACE_MS
  const peers = new Set<string>()
  let hadAny = false
  // Peers that vanished WITHOUT the signed 'left' broadcast a deliberate Leave
  // sends first, and haven't returned. Tracked per-peer (not a single flag) so
  // an intervening join by a DIFFERENT peer cannot erase the memory of one
  // still absent. The set controls end attribution after the shared grace
  // window: unexplained absence is `auto`; explained absence is `peer`.
  const unexplainedAbsent = new Set<string>()
  let graceHandle: number | null = null
  const sessionFull = room.makeAction<null>(SESSION_FULL_ACTION)

  const cancelGrace = (): void => {
    if (graceHandle !== null) {
      scheduler.clearTimeout(graceHandle)
      graceHandle = null
      log.debug('disconnect_grace.cancelled', { peerCount: peers.size })
    }
  }

  const armGrace = (): void => {
    if (graceHandle !== null) return
    log.info('disconnect_grace.armed', {
      graceMs,
      unexplainedPeerCount: unexplainedAbsent.size,
    })
    graceHandle = scheduler.setTimeout(() => {
      graceHandle = null
      // Only auto-end if the room is STILL empty — a reconnect within the
      // window cancels this via cancelGrace(). The leave handler is itself
      // idempotent, so an explicit user-leave racing the timer is safe.
      if (peers.size === 0) {
        log.info('disconnect_grace.expired', {
          graceMs,
          unexplainedPeerCount: unexplainedAbsent.size,
        })
        // Preserve why the room emptied while still giving every departure
        // the same recovery window. An unexplained absence may be a transport
        // blip, while a signed `left` means the peer chose Leave and simply
        // did not rejoin before the deadline.
        useSessionStore
          .getState()
          .setPendingEndReason(unexplainedAbsent.size > 0 ? 'auto' : 'peer')
        void hooks.leave()
      }
    }, graceMs)
  }

  if (!hooks.isHost) {
    sessionFull.receive(() => {
      log.warn('session_full.received', { role: 'guest' })
      toast.error(SESSION_FULL_MESSAGE)
      cancelGrace()
      useSessionStore.getState().setPendingEndReason('peer')
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
    // A (re)join cancels the pending end: either the transport recovered or a
    // user reversed an accidental Leave before the grace window expired.
    cancelGrace()
    unexplainedAbsent.delete(peerId)
    peers.add(peerId)
    hadAny = true
    useSessionStore.getState().peerJoined(peerId)
    log.info('peer.joined', {
      role: hooks.isHost ? 'host' : 'guest',
      peerCount: peers.size,
    })
  })

  room.onPeerLeave((peerId) => {
    if (!peers.has(peerId)) return
    peers.delete(peerId)
    const store = useSessionStore.getState()
    const explained = store.departedPeerIds.includes(peerId)
    if (!explained) unexplainedAbsent.add(peerId)
    store.peerLeft(peerId)
    log.info('peer.left', {
      role: hooks.isHost ? 'host' : 'guest',
      peerCount: peers.size,
      explained,
    })
    if (peers.size === 0 && hadAny) {
      armGrace()
    }
  })

  return {
    peers: () => Array.from(peers),
  }
}
