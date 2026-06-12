import { create } from 'zustand'

// S2 — A missed `ptt-friends-released` event (the Rust side emits it
// best-effort) latches `active` true, holding the mic open. Two guards:
//   1. `reset()` is called by SessionView's per-session reset effect AND on
//      teardown so a stuck state never bleeds into the next session's first
//      audio track (PLAN §5 default-muted).
//   2. `MAX_HOLD_MS` failsafe — `press()` arms a self-release timer so a hold
//      whose matching release is never delivered falls back to muted. This is
//      a STUCK-KEY guard, not a hold limit: macOS global hotkeys
//      (tauri_plugin_global_shortcut → Carbon RegisterEventHotKey) fire
//      `Pressed` exactly once per physical key-down with NO auto-repeat, so a
//      genuine continuous hold gets a single `press()` and must survive the
//      whole window. The threshold is set well beyond any plausible single
//      utterance (2 min) so it only bites a truly dropped release; the
//      PttIndicator flip is the user's signal that the failsafe fired.
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

export const usePttStore = create<PttState>((set) => ({
  active: false,
  press: () => {
    // Arm the stuck-key failsafe. A single press whose matching release never
    // arrives falls back to muted after MAX_HOLD_MS. clearHoldTimer() first so
    // an idempotent re-press (or a stray re-arm) never leaves two timers.
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
