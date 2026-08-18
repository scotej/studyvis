// #226 — the periodic driver behind `pttInvariants`. It owns the timer, the
// dwell bookkeeping, the heartbeat cadence and the timeline-gap check, and
// hands finished verdicts back to `PttListener` to log. Keeping it out of the
// component is what makes it testable in node-env vitest.
//
// Cadence is deliberately slow. A 1 Hz tick that logged every sample would
// write ~3,600 records an hour and wrap a log generation in about two hours —
// and it would do so precisely DURING a stuck hold, destroying the
// press/release history that explains it. So the tick is cheap and silent, and
// only a dwell-confirmed divergence, a five-minute heartbeat, or a timeline
// gap ever reaches the file.

import {
  createPttInvariantMonitor,
  type PttInvariantEvent,
  type PttObservation,
} from './pttInvariants'

export const PTT_WATCHDOG_ACTIVE_MS = 1_000
export const PTT_WATCHDOG_IDLE_MS = 5_000
export const PTT_WATCHDOG_HEARTBEAT_MS = 300_000
// Computed style forces a style recalculation, so it runs on one tick in ten
// rather than every second.
export const PTT_WATCHDOG_STYLE_EVERY = 10
// A tick this much later than scheduled means the machine slept or the app was
// suspended. That window is unattributable, and saying so is the point.
export const PTT_WATCHDOG_GAP_FACTOR = 4
export const PTT_WATCHDOG_GAP_MIN_MS = 5_000
export const PTT_WATCHDOG_GAP_MAX_RECORDS = 20

type Scheduler = {
  setTimeout: (handler: () => void, ms: number) => number
  clearTimeout: (handle: number) => void
}

const defaultScheduler: Scheduler = {
  setTimeout: (handler, ms) =>
    (globalThis.setTimeout as Window['setTimeout'])(handler, ms),
  clearTimeout: (handle) =>
    (globalThis.clearTimeout as Window['clearTimeout'])(handle),
}

let activeScheduler: Scheduler = defaultScheduler

export function __setPttWatchdogScheduler(scheduler: Scheduler): void {
  activeScheduler = scheduler
}

export function __resetPttWatchdogScheduler(): void {
  activeScheduler = defaultScheduler
}

export type PttTimelineGap = {
  expectedMs: number
  monoElapsedMs: number
  wallElapsedMs: number
  skewMs: number
  gapCount: number
}

export type PttWatchdogTick = {
  tickSeq: number
  ticks: number
  events: PttInvariantEvent[]
  observation: PttObservation
  heartbeat: boolean
  gap: PttTimelineGap | null
  openViolations: number
  budgetLeft: number
}

export type PttWatchdogDeps = {
  // Assembles the current cross-layer observation. `wantStyle` tells the
  // caller whether this tick may pay for a computed-style read.
  observe: (wantStyle: boolean) => PttObservation
  onTick: (tick: PttWatchdogTick) => void
  now?: () => number
  wallNow?: () => number
}

export type PttWatchdog = {
  start: () => void
  stop: () => void
  // Exposed for the export-time snapshot and for tests; never schedules.
  sample: (wantStyle?: boolean) => PttObservation
  openViolations: () => number
  budgetLeft: () => number
  tickSeq: () => number
  resetSession: () => void
}

export function createPttWatchdog(deps: PttWatchdogDeps): PttWatchdog {
  const now =
    deps.now ??
    (() =>
      typeof performance === 'undefined' ? Date.now() : performance.now())
  const wallNow = deps.wallNow ?? (() => Date.now())
  const monitor = createPttInvariantMonitor()

  let handle: number | null = null
  let running = false
  let tickSeq = 0
  let ticks = 0
  let gapCount = 0
  let lastHeartbeatAtMs: number | null = null
  let lastTickMonoMs: number | null = null
  let lastTickWallMs: number | null = null
  let scheduledDelayMs = PTT_WATCHDOG_IDLE_MS

  const clear = () => {
    if (handle !== null) {
      activeScheduler.clearTimeout(handle)
      handle = null
    }
  }

  const schedule = (ms: number) => {
    clear()
    if (!running) return
    scheduledDelayMs = ms
    handle = activeScheduler.setTimeout(run, ms)
  }

  function run(): void {
    handle = null
    if (!running) return

    tickSeq += 1
    ticks += 1
    const monoMs = now()
    const wallMs = wallNow()
    const wantStyle = tickSeq % PTT_WATCHDOG_STYLE_EVERY === 0

    let observation: PttObservation
    try {
      observation = deps.observe(wantStyle)
    } catch {
      // An observation that cannot be taken must not stop the watchdog; the
      // next tick may well succeed.
      schedule(scheduledDelayMs)
      return
    }

    let gap: PttTimelineGap | null = null
    if (lastTickMonoMs !== null && lastTickWallMs !== null) {
      const monoElapsedMs = Math.round(monoMs - lastTickMonoMs)
      const wallElapsedMs = Math.round(wallMs - lastTickWallMs)
      const overdue =
        monoElapsedMs >
        Math.max(
          PTT_WATCHDOG_GAP_MIN_MS,
          scheduledDelayMs * PTT_WATCHDOG_GAP_FACTOR
        )
      if (overdue && gapCount < PTT_WATCHDOG_GAP_MAX_RECORDS) {
        gapCount += 1
        gap = {
          expectedMs: scheduledDelayMs,
          monoElapsedMs,
          wallElapsedMs,
          // Wall running far ahead of monotonic is the signature of a sleep
          // rather than a busy main thread.
          skewMs: wallElapsedMs - monoElapsedMs,
          gapCount,
        }
      }
    }
    lastTickMonoMs = monoMs
    lastTickWallMs = wallMs

    // A gap means the ticks either side are not consecutive, so dwell streaks
    // built across it would be fiction. Clear the dwell history only — a gap is
    // not a new session, and `reset()` would also hand back the whole violation
    // budget, so a periodically stalling machine would never hit the ceiling.
    if (gap) monitor.resetDwell()

    const events = monitor.observe(observation)

    const heartbeatDue =
      lastHeartbeatAtMs === null ||
      monoMs - lastHeartbeatAtMs >= PTT_WATCHDOG_HEARTBEAT_MS
    if (heartbeatDue) lastHeartbeatAtMs = monoMs

    try {
      deps.onTick({
        tickSeq,
        ticks,
        events,
        observation,
        heartbeat: heartbeatDue,
        gap,
        openViolations: monitor.openViolations(),
        budgetLeft: monitor.budgetLeft(),
      })
    } catch {
      // Logging must never be able to stop the thing that observes.
    }

    schedule(
      observation.sessionActive ? PTT_WATCHDOG_ACTIVE_MS : PTT_WATCHDOG_IDLE_MS
    )
  }

  return {
    start: () => {
      if (running) return
      running = true
      lastTickMonoMs = null
      lastTickWallMs = null
      schedule(PTT_WATCHDOG_ACTIVE_MS)
    },
    stop: () => {
      running = false
      clear()
    },
    sample: (wantStyle = true) => deps.observe(wantStyle),
    openViolations: () => monitor.openViolations(),
    budgetLeft: () => monitor.budgetLeft(),
    tickSeq: () => tickSeq,
    resetSession: () => {
      monitor.reset()
      gapCount = 0
    },
  }
}

export type PttStoreChangeCause =
  'failsafe' | 'reset' | 'button' | 'unattributed'

export type PttStoreShape = {
  active: boolean
  awaitingRelease: boolean
  heldSources: readonly string[]
}

// Which store changes are worth their own record. A native press/release is
// already fully described by `edge.received`, so logging it again would double
// the per-hold volume for nothing. Everything else has no other witness.
//
// The failsafe signature is unambiguous: MAX_HOLD_MS is the ONLY path that
// clears `active` while deliberately leaving the hold latched and the sources
// intact. `release()` empties the sources, and `reset()` clears all three.
export function classifyPttStoreChange(
  previous: PttStoreShape,
  next: PttStoreShape
): PttStoreChangeCause | null {
  if (
    previous.active &&
    !next.active &&
    next.awaitingRelease &&
    next.heldSources.length > 0 &&
    next.heldSources.length === previous.heldSources.length
  ) {
    return 'failsafe'
  }

  if (
    (previous.active || previous.awaitingRelease) &&
    !next.active &&
    !next.awaitingRelease &&
    next.heldSources.length === 0 &&
    previous.heldSources.length > 0
  ) {
    // A release from the last holder looks identical from here, so only a
    // teardown-shaped clear that the native edge stream cannot explain is
    // interesting. The caller suppresses this when a native edge just fired.
    return 'reset'
  }

  const touchedButton =
    previous.heldSources.includes('session-button') !==
    next.heldSources.includes('session-button')
  if (touchedButton) return 'button'

  return null
}
