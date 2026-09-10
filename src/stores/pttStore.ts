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
    // I107 — joining is only right while the hold is LIVE. `MAX_HOLD_MS`
    // deliberately mutes a hold whose release never arrived and leaves it
    // latched (`awaitingRelease` true, `active` false), and a source that
    // joined THAT transmitted nothing: on Linux X11, where the native shortcut
    // and the in-window hold-to-talk button both exist, every later click of
    // the button joined and left a dead hold with no feedback, because the
    // button renders from `active`. Only pressing the native key again could
    // clear it. A press arriving after the failsafe is a fresh, deliberate
    // hold, so it starts one and the expired sources are dropped: their own
    // release then no-ops, and releasing this one ends the hold for good.
    if (current.active) {
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

// I108 — the in-window hold-to-talk button mutates this store directly, and a
// last-holder `release()` produces the same transition a `reset()` does;
// `classifyPttStoreChange` says as much and cannot tell them apart. PttListener
// already solved this for native edges with a latch held across the call (I92),
// but that latch is private to the native path, so every button release was
// recorded as `cause:"reset"` — a teardown that never happened, deterministic
// rather than stall-dependent, on the platform in release sign-off.
//
// This is that latch for the other caller. It lives beside the mutations it
// brackets so the two ends cannot drift apart, and it is a depth counter rather
// than a boolean so a nested call cannot clear it early.
let buttonMutationDepth = 0

export function inPttButtonMutation(): boolean {
  return buttonMutationDepth > 0
}

export function withPttButtonMutation<T>(run: () => T): T {
  buttonMutationDepth += 1
  try {
    return run()
  } finally {
    buttonMutationDepth -= 1
  }
}
