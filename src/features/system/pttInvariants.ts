// #226 — push-to-talk desync has now been reported three times (#156, #209,
// #226) and each report arrived with an archive that could not settle it. The
// #226 archives are the clearest case: both ends of the session logged 14
// matched press/release pairs and every release recorded `activeAfter:false`,
// so the logs described a healthy run while the user watched a lit indicator.
// Nothing in the file described the layers BETWEEN the store and the user, so
// the report was unfalsifiable rather than wrong.
//
// This module is the answer to that. It evaluates the cross-layer PTT
// invariants on a slow tick and reports a divergence as a single
// self-contained record, so an archive states its own fault instead of leaving
// one to be inferred.
//
// ── READING AN ARCHIVE ─────────────────────────────────────────────────────
// Three words, used precisely. Do not mix them.
//
//   diverged       — a `ptt.invariant` record. A real, dwell-confirmed
//                    disagreement between two layers.
//   unattributable — coverage is missing: a `ptt.watchdog/timeline.gap`, a
//                    `log/dropped`, or `logHealth.sinkDisabled`. Claim NOTHING
//                    about that window; silence there is not evidence.
//   undelivered    — a `win:"native"` count exceeds the renderer's count for
//                    the same stream. An event left Rust and never arrived.
//
// Watcher liveness is NOT an invariant here — see the note under the table.
// Read `ptt.native` `watcher.armed` / `watcher.exited` instead: a thread that
// armed without a matching exit, or an exit whose `emitOk` exceeds the
// renderer's `native.physicalEvents`, is the real evidence.
//
// Step 0 is always coverage, never the symptom: read `ptt.watchdog/armed`
// (platform, whether a physical watcher exists at all) and the last
// `ptt/export.snapshot` (live state at the user's click, plus `logHealth`)
// BEFORE reading anything else. On Windows and Linux `physicalHeld` is `null`
// for the whole run and no physical-state stream exists — that absence is the
// platform, not a defect.
//
// Then grep `"scope":"ptt.invariant"`. If a record is present it carries the
// complete cross-layer state at the confirmed divergence, and its `msg` is the
// conclusion. The mapping from each `msg` to what it means is in the PR that
// introduced this file and in `docs`-free form below, beside each predicate.
//
// ── WHY DWELL ─────────────────────────────────────────────────────────────
// Every one of these predicates is legitimately true for a few milliseconds
// mid-transition, when one layer has moved and the next has not. A violation
// therefore requires the predicate to hold across N consecutive ticks AND a
// minimum wall duration AND an UNCHANGED `pttStore.revision` — a revision bump
// means the state machine moved, which is the definition of "not stuck". The
// emitted record carries `revisionAtFirst`/`revisionNow` so a reader can check
// that judgement instead of trusting it.

export type PttPlatform = 'macos' | 'windows' | 'linux' | 'unknown'

export type PttStoreObservation = {
  active: boolean
  awaitingRelease: boolean
  heldSources: readonly string[]
  revision: number
  holdMs: number | null
}

export type PttReconcilerObservation = {
  physicalHeld: boolean | null
  shortcutDown: boolean
  logicalHoldActive: boolean
  deferredShortcutPress: boolean
}

export type PttTrackObservation = {
  roomActive: boolean
  peerConnections: number
  audioSenders: number
  enabledAudioSenders: number
  liveAudioSenders: number
  audioReceivers: number
  liveAudioReceivers: number
  collectionError: boolean
}

export type PttRenderObservation = {
  // null = the surface was not found, which is different from "found and off".
  selfLit: boolean | null
  opacityLit: boolean | null
  peerLit: number
  peerTiles: number
  holdButtonPressed: boolean | null
  surfaces: number
  probeError: boolean
}

export type PttBroadcastObservation = {
  lastActive: boolean | null
  msSinceSend: number | null
  sends: number
  sendFails: number
  lastKind: string | null
}

export type PttNativeObservation = {
  lastPhysicalHeld: boolean | null
  msSincePhysical: number | null
  physicalEvents: number
  pressedEvents: number
  releasedEvents: number
}

export type PttObservation = {
  atMs: number
  sessionActive: boolean
  platform: PttPlatform
  // macOS only. Gates the invariants that would otherwise fire forever on a
  // platform that has no physical-state stream by design.
  physicalWatchExpected: boolean
  peerPttActive: number
  store: PttStoreObservation
  reconciler: PttReconcilerObservation
  track: PttTrackObservation
  render: PttRenderObservation
  broadcast: PttBroadcastObservation
  native: PttNativeObservation
}

export type PttInvariantId =
  | 'track.enabled_while_inactive'
  | 'track.disabled_while_active'
  | 'indicator.disagrees_with_store'
  | 'broadcast.disagrees_with_store'
  | 'hold.muted_while_latched'
  | 'hold.store_without_reconciler'
  | 'hold.reconciler_without_store'
  | 'physical.up_while_active'
  | 'physical.watcher_silent'

export type PttInvariantEvent =
  | {
      kind: 'violation' | 'cleared'
      id: PttInvariantId
      level: 'warn' | 'error'
      dwellMs: number
      ticks: number
      enterCount: number
      revisionAtFirst: number
      revisionNow: number
    }
  | { kind: 'budget-exhausted'; suppressedSinceMs: number }

type Invariant = {
  id: PttInvariantId
  level: 'warn' | 'error'
  dwellTicks: number
  minDwellMs: number
  requiresPhysicalWatch: boolean
  // A session must be live for anything media- or peer-shaped to mean
  // anything; outside one there are no senders and no tiles.
  requiresSession: boolean
  predicate: (o: PttObservation) => boolean
}

const heldByShortcut = (o: PttObservation): boolean =>
  o.store.heldSources.includes('native-shortcut')

export const PTT_INVARIANTS: readonly Invariant[] = [
  // The mic is live while the app believes it is not transmitting. This is the
  // privacy-relevant direction and is always an error.
  {
    id: 'track.enabled_while_inactive',
    level: 'error',
    dwellTicks: 2,
    minDwellMs: 1_500,
    requiresPhysicalWatch: false,
    requiresSession: true,
    predicate: (o) =>
      !o.store.active &&
      !o.track.collectionError &&
      o.track.enabledAudioSenders > 0 &&
      // An `enabled` but ENDED sender is not a live microphone; reporting it as
      // one would be a permanent privacy-level error about nothing.
      o.track.liveAudioSenders > 0,
  },
  // The literal #226 shape from the other side: the app says transmitting, the
  // sender track is muted. The user sees a lit indicator and is not heard.
  {
    id: 'track.disabled_while_active',
    level: 'error',
    dwellTicks: 2,
    minDwellMs: 1_500,
    requiresPhysicalWatch: false,
    requiresSession: true,
    predicate: (o) =>
      o.store.active &&
      !o.track.collectionError &&
      o.track.audioSenders > 0 &&
      // `< audioSenders`, not `=== 0`: with several peers, one sender left
      // disabled is the same fault for that listener and must not hide behind
      // the others. Matches `classifyPttMediaSnapshot`'s edge-triggered rule.
      o.track.enabledAudioSenders < o.track.audioSenders,
  },
  // A pure render fault: the committed DOM disagrees with the store. This is
  // the one shape the old instrumentation could not see at all, because every
  // record it wrote was derived from the store it was trying to check.
  {
    id: 'indicator.disagrees_with_store',
    level: 'error',
    dwellTicks: 2,
    minDwellMs: 1_500,
    requiresPhysicalWatch: false,
    requiresSession: true,
    predicate: (o) =>
      !o.render.probeError &&
      ((o.render.selfLit !== null && o.render.selfLit !== o.store.active) ||
        // The badge is shown by opacity, so what the user SEES can disagree
        // with the committed attribute. #226 was reported as a visibly lit
        // indicator; measuring this and never asserting on it would leave the
        // literal symptom undetected.
        (o.render.opacityLit !== null &&
          o.render.opacityLit !== o.store.active)),
  },
  // We told peers one thing and believe another. `msSinceSend` keeps a send
  // that is merely in flight from counting.
  {
    id: 'broadcast.disagrees_with_store',
    level: 'error',
    dwellTicks: 2,
    minDwellMs: 1_500,
    requiresPhysicalWatch: false,
    requiresSession: true,
    predicate: (o) =>
      o.broadcast.lastActive !== null &&
      o.broadcast.lastActive !== o.store.active &&
      o.broadcast.msSinceSend !== null &&
      o.broadcast.msSinceSend > 1_000,
  },
  // Uniquely the steady state left by pttStore's MAX_HOLD_MS failsafe: it
  // forces `active` false but deliberately keeps the hold latched. Derived
  // from state, so it survives even when the edge record has rotated away.
  {
    id: 'hold.muted_while_latched',
    level: 'warn',
    dwellTicks: 2,
    minDwellMs: 1_500,
    requiresPhysicalWatch: false,
    requiresSession: false,
    predicate: (o) => o.store.awaitingRelease && !o.store.active,
  },
  {
    id: 'hold.store_without_reconciler',
    level: 'error',
    dwellTicks: 2,
    minDwellMs: 1_500,
    requiresPhysicalWatch: false,
    requiresSession: false,
    predicate: (o) => heldByShortcut(o) && !o.reconciler.logicalHoldActive,
  },
  {
    id: 'hold.reconciler_without_store',
    level: 'error',
    dwellTicks: 2,
    minDwellMs: 1_500,
    requiresPhysicalWatch: false,
    requiresSession: false,
    predicate: (o) => o.reconciler.logicalHoldActive && !heldByShortcut(o),
  },
  // macOS reports the chord physically up while the store keeps transmitting
  // from the shortcut. This is the single most diagnostic line the #226
  // archives could have carried and did not.
  {
    id: 'physical.up_while_active',
    level: 'error',
    dwellTicks: 3,
    minDwellMs: 2_000,
    requiresPhysicalWatch: true,
    requiresSession: false,
    predicate: (o) =>
      o.reconciler.physicalHeld === false &&
      o.store.active &&
      heldByShortcut(o),
  },
]

// There is deliberately NO `physical.watcher_silent` invariant. The obvious one
// — "no physical-state event for N seconds means the watcher died" — is wrong
// here, in both directions. The macOS watcher (#240) is a bounded level
// confirmer: it republishes a level about eleven times over one second and then
// goes intentionally quiet until the level CHANGES, precisely so an idle
// session produces no steady-state IPC. So silence is the normal state of a
// healthy session in which nobody has touched the key, and asserting on it
// would fire on the single most common runtime condition and spend the shared
// budget that the media, render and broadcast invariants depend on — producing
// the "archive looks clean" failure this whole module exists to prevent. It is
// also unable to detect the fault it names: a watcher that dies before its
// first delivery leaves `msSincePhysical` null forever.
//
// Watcher liveness is answered properly from the other side instead, by the
// `ptt.native` `watcher.armed` / `watcher.exited` records, which state the
// generation, the exit reason and the emit counts as facts rather than
// inferring them from an absence. Do not add this invariant back without first
// making the watcher republish on a real keepalive cadence.

// A permanently stuck state must cost a handful of records, not a flood. Each
// invariant re-asserts on this schedule; the 15 s floor clears
// THROTTLE_WINDOW_MS so a warn/error violation can never fold onto `n` and
// lose the fields that explain it.
export const PTT_INVARIANT_BACKOFF_MS: readonly number[] = [
  15_000, 45_000, 135_000, 300_000,
]

// Shared ceiling across all invariants for one session. Reached only in a
// pathological run, and `budget-exhausted` makes the self-silencing explicit
// so an archive that stops carrying violations is never read as a recovery.
export const PTT_INVARIANT_BUDGET = 40

export type PttInvariantMonitor = {
  observe: (observation: PttObservation) => PttInvariantEvent[]
  openViolations: () => number
  budgetLeft: () => number
  resetDwell: () => void
  reset: () => void
}

type InvariantState = {
  ticks: number
  firstAtMs: number | null
  revisionAtFirst: number
  enterCount: number
  emitCount: number
  lastEmitAtMs: number | null
  open: boolean
}

function freshState(): InvariantState {
  return {
    ticks: 0,
    firstAtMs: null,
    revisionAtFirst: 0,
    enterCount: 0,
    emitCount: 0,
    lastEmitAtMs: null,
    open: false,
  }
}

export function createPttInvariantMonitor(options?: {
  invariants?: readonly Invariant[]
  budget?: number
  backoffMs?: readonly number[]
}): PttInvariantMonitor {
  const invariants = options?.invariants ?? PTT_INVARIANTS
  const budget = options?.budget ?? PTT_INVARIANT_BUDGET
  const backoff = options?.backoffMs ?? PTT_INVARIANT_BACKOFF_MS

  const states = new Map<PttInvariantId, InvariantState>()
  let spent = 0
  let exhaustedReported = false
  let suppressedSinceMs = 0

  const stateFor = (id: PttInvariantId): InvariantState => {
    const existing = states.get(id)
    if (existing) return existing
    const created = freshState()
    states.set(id, created)
    return created
  }

  return {
    observe: (o) => {
      const events: PttInvariantEvent[] = []

      for (const invariant of invariants) {
        const state = stateFor(invariant.id)
        const applicable =
          (!invariant.requiresPhysicalWatch || o.physicalWatchExpected) &&
          (!invariant.requiresSession || o.sessionActive)
        const violated = applicable && invariant.predicate(o)

        if (!violated) {
          // A `cleared` is a full-payload record like any other, so it spends
          // budget like any other. Without this a predicate that flaps every
          // other tick writes an unbounded stream of them — and keeps writing
          // after `budget-exhausted` has told the reader the monitor went
          // quiet, which is worse than silence because it is a lie.
          if (state.open && spent < budget) {
            spent += 1
            events.push({
              kind: 'cleared',
              id: invariant.id,
              level: invariant.level,
              dwellMs: state.firstAtMs === null ? 0 : o.atMs - state.firstAtMs,
              ticks: state.ticks,
              enterCount: state.enterCount,
              revisionAtFirst: state.revisionAtFirst,
              revisionNow: o.store.revision,
            })
          }
          state.open = false
          state.ticks = 0
          state.firstAtMs = null
          // `emitCount`/`lastEmitAtMs` deliberately SURVIVE a clear: the
          // backoff ladder is per-invariant-per-session, not per-episode.
          // Resetting them let a flapping predicate re-enter at full rate and
          // land inside THROTTLE_WINDOW_MS, where a repeated warn/error folds
          // onto `n` and loses every field that explains it.
          continue
        }

        // A revision bump means the PTT state machine moved, so whatever was
        // disagreeing was a transition and not a stuck state. Restart the
        // dwell from here rather than counting across the change.
        if (state.ticks === 0 || state.revisionAtFirst !== o.store.revision) {
          state.ticks = 1
          state.firstAtMs = o.atMs
          state.revisionAtFirst = o.store.revision
        } else {
          state.ticks += 1
        }

        const dwellMs = o.atMs - (state.firstAtMs ?? o.atMs)
        if (
          state.ticks < invariant.dwellTicks ||
          dwellMs < invariant.minDwellMs
        ) {
          continue
        }

        if (!state.open) {
          state.open = true
          state.enterCount += 1
        }

        const waitMs =
          backoff[Math.min(state.emitCount, backoff.length - 1)] ?? 0
        if (
          state.lastEmitAtMs !== null &&
          o.atMs - state.lastEmitAtMs < waitMs
        ) {
          continue
        }

        if (spent >= budget) {
          if (!exhaustedReported) {
            exhaustedReported = true
            suppressedSinceMs = o.atMs
            events.push({ kind: 'budget-exhausted', suppressedSinceMs })
          }
          continue
        }

        spent += 1
        state.emitCount += 1
        state.lastEmitAtMs = o.atMs
        events.push({
          kind: 'violation',
          id: invariant.id,
          level: invariant.level,
          dwellMs,
          ticks: state.ticks,
          enterCount: state.enterCount,
          revisionAtFirst: state.revisionAtFirst,
          revisionNow: o.store.revision,
        })
      }

      return events
    },

    openViolations: () => {
      let open = 0
      for (const state of states.values()) if (state.open) open += 1
      return open
    },

    budgetLeft: () => Math.max(0, budget - spent),

    // Dwell counted across a suspend or a long stall would be fiction, because
    // the ticks either side are not consecutive observations. The BUDGET is
    // deliberately untouched: a gap is not a new session, and letting one hand
    // back a fresh allowance would defeat the ceiling entirely.
    resetDwell: () => {
      states.clear()
    },

    // A session owns its own budget and its own dwell history: a divergence
    // that spanned a room change is a different fact from one inside a room.
    reset: () => {
      states.clear()
      spent = 0
      exhaustedReported = false
      suppressedSinceMs = 0
    },
  }
}
