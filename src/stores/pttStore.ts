import { create } from 'zustand'

// S2 / I85 / #209 — a missed `ptt-friends-released` event can latch `active`
// true, while some native shortcut stacks can also deliver duplicate/repeated
// Pressed edges during one physical hold. PTT is hold-to-talk, so a Pressed
// edge must never mean "release": repeated press() calls are idempotent.
//
// `awaitingRelease` is deliberately distinct from `active`. The first Pressed
// edge starts one logical hold and sets both. More than one input source can
// own that hold on Linux (the native shortcut plus the in-window Wayland
// fallback), so `heldSources` keeps a release from one source from cancelling
// another source that is still physically down. The 120-second safety timer
// may force `active` false, but it MUST leave the hold latched: otherwise a
// repeated Pressed edge could re-open the microphone for another two minutes.
//
// Three independent guards keep the microphone fail-safe:
//   1. `reset()` is called by SessionView's per-session reset effect AND on
//      teardown so a stuck state never bleeds into the next session's first
//      audio track (PLAN §5 default-muted).
//   2. Duplicate/repeated `press()` calls while `awaitingRelease` are ignored
//      and DO NOT re-arm the failsafe, including after that failsafe has muted
//      the current hold.
//   3. `MAX_HOLD_MS` is the last-resort stuck-key guard: the first press arms a
//      self-mute timer. The physical hold remains latched until Released so the
//      cutoff is authoritative rather than a renewable timeout.
//
// `revision` is a monotonic local state generation used by diagnostics to
// detect an edge/failsafe racing an async WebRTC stats sample. It changes only
// when the logical PTT state changes, never for duplicate edges.
//
// The timer is module-scoped (not store state) so it never participates in
// equality checks / re-renders. Unit-tested via the injectable clock seam.

export const MAX_HOLD_MS = 120_000

export type PttSource = 'native-shortcut' | 'session-button'

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
  awaitingRelease: boolean
  heldSources: PttSource[]
  revision: number
  press: (source?: PttSource) => void
  release: (source?: PttSource) => void
  reset: () => void
}

export const usePttStore = create<PttState>((set, get) => ({
  active: false,
  awaitingRelease: false,
  heldSources: [],
  revision: 0,
  press: (source = 'native-shortcut') => {
    const current = get()
    // A repeat from this physical source is always a no-op. A second source
    // joins the existing hold without extending its failsafe deadline.
    if (current.heldSources.includes(source)) return
    if (current.awaitingRelease) {
      set({ heldSources: [...current.heldSources, source] })
      return
    }

    clearHoldTimer()
    holdTimer = activeScheduler.setTimeout(() => {
      holdTimer = null
      const current = get()
      if (!current.awaitingRelease || !current.active) return
      set((state) => ({
        active: false,
        revision: state.revision + 1,
      }))
    }, MAX_HOLD_MS)
    set((state) => ({
      active: true,
      awaitingRelease: true,
      heldSources: [source],
      revision: state.revision + 1,
    }))
  },
  release: (source = 'native-shortcut') => {
    const current = get()
    if (!current.heldSources.includes(source)) return
    const heldSources = current.heldSources.filter((held) => held !== source)
    if (heldSources.length > 0) {
      set({ heldSources })
      return
    }

    clearHoldTimer()
    set((state) => ({
      active: false,
      awaitingRelease: false,
      heldSources: [],
      revision: state.revision + 1,
    }))
  },
  reset: () => {
    clearHoldTimer()
    const current = get()
    if (!current.active && !current.awaitingRelease) return
    set((state) => ({
      active: false,
      awaitingRelease: false,
      heldSources: [],
      revision: state.revision + 1,
    }))
  },
}))
