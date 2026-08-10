import { create } from 'zustand'

// S2 / I85 / #209 — a missed `ptt-friends-released` event can latch `active`
// true, while some native shortcut stacks can also deliver duplicate/repeated
// Pressed edges during one physical hold. PTT is hold-to-talk, so a Pressed
// edge must never mean "release": repeated press() calls are idempotent.
//
// Three independent guards keep the microphone fail-safe:
//   1. `reset()` is called by SessionView's per-session reset effect AND on
//      teardown so a stuck state never bleeds into the next session's first
//      audio track (PLAN §5 default-muted).
//   2. Duplicate/repeated `press()` calls while already active are ignored and
//      DO NOT re-arm the failsafe. This preserves one continuous hold even if
//      the native bridge repeats Pressed, and keeps the original timeout bound
//      if the matching Released edge is genuinely lost.
//   3. `MAX_HOLD_MS` is the last-resort stuck-key guard: the first press arms a
//      self-release timer, so a missing release eventually returns to muted.
//      The threshold is intentionally far beyond a normal utterance (2 min).
//
// The timer is module-scoped (not store state) so it never participates in
// equality checks / re-renders. Unit-tested via the injectable clock seam.

export const MAX_HOLD_MS = 120_000

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
let holdTimer: number | null = null

export function __setPttScheduler(scheduler: Scheduler): void {
  activeScheduler = scheduler
}

export function __resetPttScheduler(): void {
  if (holdTimer !== null) {
    activeScheduler.clearTimeout(holdTimer)
    holdTimer = null
  }
  activeScheduler = defaultScheduler
}

function clearHoldTimer(): void {
  if (holdTimer !== null) {
    activeScheduler.clearTimeout(holdTimer)
    holdTimer = null
  }
}

type PttState = {
  active: boolean
  press: () => void
  release: () => void
  reset: () => void
}

export const usePttStore = create<PttState>((set, get) => ({
  active: false,
  press: () => {
    // A repeat/duplicate Pressed edge during one physical hold is a no-op.
    // Never clear/re-arm the timer here: if Released was genuinely lost, the
    // original MAX_HOLD_MS deadline must remain authoritative.
    if (get().active) return

    clearHoldTimer()
    holdTimer = activeScheduler.setTimeout(() => {
      holdTimer = null
      set({ active: false })
    }, MAX_HOLD_MS)
    set({ active: true })
  },
  release: () => {
    clearHoldTimer()
    set({ active: false })
  },
  reset: () => {
    clearHoldTimer()
    set({ active: false })
  },
}))
