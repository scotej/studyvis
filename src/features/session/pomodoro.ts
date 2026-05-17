// Pomodoro timer with broadcaster handover (ARCHITECTURE.md §10).
//
// One peer is the broadcaster — by default whoever started the timer. They
// send `{ type: "pomodoro", phase, ends_at, preset }` on the data channel
// every 5s while a phase is active. Receivers display the phase + countdown
// and never transition autonomously: phase changes happen only when the
// broadcaster sends a new message. This is the §10 "avoids drift" rule.
//
// On broadcaster disconnect: each peer waits 10s of silence; if no pomodoro
// message arrives, the next-oldest peer (by signed-hello `joined_at`) takes
// over and resumes from the same `ends_at`. The new broadcaster picks up
// the existing 5s-tick broadcast loop without resetting the phase, so the
// timer continues seamlessly.
//
// Deliberate stop is distinct from disconnect: `stop()` sends one final
// message with `stopped: true` so receivers reset to idle instead of
// handing over (silence alone can't tell the two apart). A dropped stop
// degrades gracefully to the old silence/handover path.
//
// Wire-shape note: ARCHITECTURE.md §7 spec'd `phase: "work" | "rest"` — we
// keep that 2-state on the wire AND add a `preset` field so receivers can
// label the active phase as 25/5 vs 50/10. The internal state machine still
// tracks the 5-state model (idle | work-25 | rest-5 | work-50 | rest-10)
// requested by the V1-P9 prompt; the wire layer is just less granular.

import type {
  PomodoroPhase,
  PomodoroPreset,
  PomodoroSnapshot,
} from '@/lib/pomodoro-types'
import type { TopicRoom } from '@/lib/trystero'

export type {
  PomodoroPhase,
  PomodoroPreset,
  PomodoroSnapshot,
} from '@/lib/pomodoro-types'

export const POMODORO_ACTION = 'pomodoro'
export const BROADCAST_INTERVAL_MS = 5_000
export const HANDOVER_SILENCE_MS = 10_000

export type WirePhase = 'work' | 'rest'

const PRESET_DURATIONS: Record<PomodoroPreset, { work: number; rest: number }> =
  {
    '25/5': { work: 25 * 60_000, rest: 5 * 60_000 },
    '50/10': { work: 50 * 60_000, rest: 10 * 60_000 },
  }

export type PomodoroMessage = {
  v: 1
  phase: WirePhase
  preset: PomodoroPreset
  ends_at: number
  // Set by the broadcaster's `stop()` so receivers can distinguish a
  // deliberate stop from a disconnect. Silence alone is ambiguous (it
  // triggers handover), so the terminal transition needs an explicit
  // signal — see ARCHITECTURE.md §7.
  stopped?: true
}

export function isPomodoroMessage(value: unknown): value is PomodoroMessage {
  if (!value || typeof value !== 'object') return false
  const v = value as Partial<PomodoroMessage>
  return (
    v.v === 1 &&
    (v.phase === 'work' || v.phase === 'rest') &&
    (v.preset === '25/5' || v.preset === '50/10') &&
    (v.stopped === undefined || v.stopped === true) &&
    // NaN / Infinity would poison the countdown math
    // (`Math.max(0, endsAt - now)` returns NaN), so require a finite
    // positive timestamp.
    typeof v.ends_at === 'number' &&
    Number.isFinite(v.ends_at) &&
    v.ends_at > 0
  )
}

// Returns the 5-state phase from wire (phase, preset). Used by the UI to
// label the active interval.
export function fullPhase(
  wire: WirePhase,
  preset: PomodoroPreset
): Exclude<PomodoroPhase, 'idle'> {
  if (preset === '25/5') return wire === 'work' ? 'work-25' : 'rest-5'
  return wire === 'work' ? 'work-50' : 'rest-10'
}

export type PeerOrderingEntry = {
  ed_pubkey_hex: string
  joined_at: number
}

// Pure: given the set of peers (including self) and the current broadcaster,
// returns the ed_pubkey_hex of whoever should take over on broadcaster
// silence. Sort by joined_at ascending; tie-break by lex ed_pubkey_hex so
// every peer agrees deterministically. Returns null if no eligible peer
// exists (everyone but the broadcaster has left).
export function pickNextBroadcaster(
  peers: ReadonlyArray<PeerOrderingEntry>,
  currentBroadcaster: string | null
): string | null {
  const eligible = peers.filter((p) => p.ed_pubkey_hex !== currentBroadcaster)
  if (eligible.length === 0) return null
  const sorted = [...eligible].sort((a, b) => {
    if (a.joined_at !== b.joined_at) return a.joined_at - b.joined_at
    if (a.ed_pubkey_hex === b.ed_pubkey_hex) return 0
    return a.ed_pubkey_hex < b.ed_pubkey_hex ? -1 : 1
  })
  return sorted[0].ed_pubkey_hex
}

export type ControllerArgs = {
  room: TopicRoom
  myEdPubkeyHex: string
  selfJoinedAt: number
  // Snapshot of all known peers (incl. self) at handover-decision time. The
  // controller calls this when it needs to compute the next broadcaster.
  getAllPeerOrdering: () => PeerOrderingEntry[]
  // Resolves `senderPeerId` to its bound `ed_pubkey_hex` (from signed-hello).
  // Returns null if no binding has been seen — drop the message.
  resolveSenderEdPubkey: (senderPeerId: string) => string | null
  onSnapshot: (snapshot: PomodoroSnapshot) => void
  // Audit-log hooks: fires on local start/stop transitions only (so receivers
  // see audit events from whoever is broadcaster when start/stop happens, no
  // duplicate entries). Provider runs the broadcast — see SessionView.
  onPomodoroStart: (preset: PomodoroPreset) => void
  onPomodoroEnd: () => void
  // Test seams.
  now?: () => number
  setTimeoutFn?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  setIntervalFn?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>
  clearTimeoutFn?: (h: ReturnType<typeof setTimeout>) => void
  clearIntervalFn?: (h: ReturnType<typeof setInterval>) => void
}

export type PomodoroController = {
  start: (preset: PomodoroPreset) => void
  stop: () => void
  teardown: () => void
}

// Wires the data-channel pomodoro action and manages broadcaster role +
// handover. The controller maintains:
//   - `state`: current snapshot pushed to onSnapshot whenever it changes.
//   - `broadcastInterval`: 5s tick fired only when iAmBroadcaster.
//   - `silenceTimer`: 10s setTimeout reset on every received pomodoro msg;
//     fires the handover decision if it expires (advisor note #5 — fake
//     timers must be able to drive this).
export function startPomodoroController(
  args: ControllerArgs
): PomodoroController {
  const setTimeoutFn = args.setTimeoutFn ?? setTimeout
  const setIntervalFn = args.setIntervalFn ?? setInterval
  const clearTimeoutFn = args.clearTimeoutFn ?? clearTimeout
  const clearIntervalFn = args.clearIntervalFn ?? clearInterval
  const now = () => (args.now ? args.now() : Date.now())

  const action = args.room.makeAction<PomodoroMessage>(POMODORO_ACTION)

  let state: PomodoroSnapshot = {
    phase: 'idle',
    endsAt: null,
    preset: null,
    broadcasterEdPubkey: null,
    iAmBroadcaster: false,
  }
  let broadcastInterval: ReturnType<typeof setInterval> | null = null
  let phaseTransitionTimer: ReturnType<typeof setTimeout> | null = null
  let silenceTimer: ReturnType<typeof setTimeout> | null = null
  let teardownCalled = false

  const pushSnapshot = () => args.onSnapshot({ ...state })

  const stopBroadcasting = () => {
    if (broadcastInterval !== null) {
      clearIntervalFn(broadcastInterval)
      broadcastInterval = null
    }
    if (phaseTransitionTimer !== null) {
      clearTimeoutFn(phaseTransitionTimer)
      phaseTransitionTimer = null
    }
  }

  const resetSilenceTimer = () => {
    if (silenceTimer !== null) clearTimeoutFn(silenceTimer)
    silenceTimer = setTimeoutFn(onSilenceExpired, HANDOVER_SILENCE_MS)
  }

  const cancelSilenceTimer = () => {
    if (silenceTimer !== null) {
      clearTimeoutFn(silenceTimer)
      silenceTimer = null
    }
  }

  const broadcastTick = () => {
    if (state.phase === 'idle' || !state.preset || state.endsAt == null) return
    const wire: WirePhase = state.phase.startsWith('work') ? 'work' : 'rest'
    const msg: PomodoroMessage = {
      v: 1,
      phase: wire,
      preset: state.preset,
      ends_at: state.endsAt,
    }
    void action.send(msg).catch(() => {
      // best-effort; the next tick or the receiver's own silence timer
      // will catch any single dropped message.
    })
  }

  // Schedule the broadcaster's local phase transition. When ends_at hits,
  // the broadcaster flips to the next half of the preset and starts a fresh
  // duration. Receivers don't run this — they wait for the next tick.
  const schedulePhaseTransition = () => {
    if (phaseTransitionTimer !== null) clearTimeoutFn(phaseTransitionTimer)
    if (state.phase === 'idle' || !state.preset || state.endsAt == null) return
    const remaining = Math.max(0, state.endsAt - now())
    phaseTransitionTimer = setTimeoutFn(advancePhaseLocal, remaining)
  }

  const advancePhaseLocal = () => {
    if (!state.iAmBroadcaster) return
    if (state.phase === 'idle' || !state.preset) return
    const dur = PRESET_DURATIONS[state.preset]
    const isWork = state.phase.startsWith('work')
    const nextPhase: PomodoroPhase = isWork
      ? state.preset === '25/5'
        ? 'rest-5'
        : 'rest-10'
      : state.preset === '25/5'
        ? 'work-25'
        : 'work-50'
    const nextDur = isWork ? dur.rest : dur.work
    state = {
      ...state,
      phase: nextPhase,
      endsAt: now() + nextDur,
    }
    pushSnapshot()
    broadcastTick()
    schedulePhaseTransition()
  }

  // Locally start broadcasting (called by the user-initiated start AND by
  // the handover takeover path, which carries forward the existing endsAt
  // and preset rather than resetting).
  const becomeBroadcaster = (preset: PomodoroPreset, endsAt: number) => {
    cancelSilenceTimer()
    const isPostHandover =
      state.phase !== 'idle' &&
      state.preset === preset &&
      state.endsAt === endsAt
    state = {
      phase: isPostHandover
        ? state.phase
        : preset === '25/5'
          ? 'work-25'
          : 'work-50',
      endsAt,
      preset,
      broadcasterEdPubkey: args.myEdPubkeyHex,
      iAmBroadcaster: true,
    }
    pushSnapshot()
    broadcastTick()
    if (broadcastInterval !== null) clearIntervalFn(broadcastInterval)
    broadcastInterval = setIntervalFn(broadcastTick, BROADCAST_INTERVAL_MS)
    schedulePhaseTransition()
  }

  const onSilenceExpired = () => {
    silenceTimer = null
    if (state.phase === 'idle' || !state.preset || state.endsAt == null) {
      return
    }
    if (state.iAmBroadcaster) return
    const next = pickNextBroadcaster(
      args.getAllPeerOrdering(),
      state.broadcasterEdPubkey
    )
    if (next === null) {
      // Broadcaster is gone and there is no successor — everyone else has
      // left too. Local UI was still showing the pre-silence phase; reset
      // it locally so the timer doesn't appear frozen forever. No broadcast
      // (no one to receive) and no audit hook (we are not the broadcaster
      // emitting an end event).
      stopBroadcasting()
      state = {
        phase: 'idle',
        endsAt: null,
        preset: null,
        broadcasterEdPubkey: null,
        iAmBroadcaster: false,
      }
      pushSnapshot()
      return
    }
    if (next === args.myEdPubkeyHex) {
      becomeBroadcaster(state.preset, state.endsAt)
    } else {
      // Wait for the new broadcaster's first message; arm a fresh silence
      // timer so a chain of disconnects keeps cascading.
      resetSilenceTimer()
    }
  }

  // Trystero has no `action.deregister` API. The receive handler stays
  // wired to the underlying RTCDataChannel for the lifetime of the room.
  // That is fine because the room is per-session — `wireSessionRoom` /
  // `buildLeaveHandler` close the room (and its channels) on session end.
  // Don't try to "fix" this by adding a manual deregister; it would either
  // be a no-op or break the post-handover state-update path when one
  // controller-instance receives messages while another is mid-teardown.
  action.receive((data, peerId) => {
    if (teardownCalled) return
    if (!isPomodoroMessage(data)) return
    const senderEd = args.resolveSenderEdPubkey(peerId)
    if (!senderEd) return
    if (data.stopped === true) {
      // The broadcaster deliberately ended the timer. Reset to idle and do
      // NOT arm the silence timer — this is a stop, not a disconnect, so
      // there is no handover. Must be the first branch so a stale `state`
      // never arms the silence cascade.
      stopBroadcasting()
      cancelSilenceTimer()
      state = {
        phase: 'idle',
        endsAt: null,
        preset: null,
        broadcasterEdPubkey: null,
        iAmBroadcaster: false,
      }
      pushSnapshot()
      return
    }
    // Friend-pair model accepts brief two-broadcaster overlap on
    // reconnection — treat the most recent sender as broadcaster (advisor
    // note #8). If the message is from the broadcaster we already track,
    // this is just a normal tick + silence-timer reset.
    const fullPhaseLocal = fullPhase(data.phase, data.preset)
    state = {
      phase: fullPhaseLocal,
      endsAt: data.ends_at,
      preset: data.preset,
      broadcasterEdPubkey: senderEd,
      iAmBroadcaster: senderEd === args.myEdPubkeyHex,
    }
    pushSnapshot()
    if (state.iAmBroadcaster) {
      // We are receiving our own broadcast (loopback shouldn't normally
      // happen but trystero may echo on some strategies). Don't arm a
      // silence timer against ourselves.
      return
    }
    // We trust someone else's broadcast — stop our own broadcast loop if
    // we were broadcasting. This handles the "original broadcaster comes
    // back" case: we yield to the most recent sender.
    stopBroadcasting()
    resetSilenceTimer()
  })

  return {
    start: (preset) => {
      const dur = PRESET_DURATIONS[preset].work
      const endsAt = now() + dur
      // Reset state to a fresh start regardless of any prior state.
      state = {
        phase: preset === '25/5' ? 'work-25' : 'work-50',
        endsAt,
        preset,
        broadcasterEdPubkey: args.myEdPubkeyHex,
        iAmBroadcaster: true,
      }
      cancelSilenceTimer()
      pushSnapshot()
      args.onPomodoroStart(preset)
      broadcastTick()
      if (broadcastInterval !== null) clearIntervalFn(broadcastInterval)
      broadcastInterval = setIntervalFn(broadcastTick, BROADCAST_INTERVAL_MS)
      schedulePhaseTransition()
    },
    stop: () => {
      if (state.phase === 'idle') return
      const wasBroadcaster = state.iAmBroadcaster
      // Send the explicit stop signal BEFORE resetting state, while
      // phase/preset/endsAt are still valid, so receivers go idle instead
      // of treating the ensuing silence as a disconnect and handing over.
      if (wasBroadcaster && state.preset && state.endsAt != null) {
        const wire: WirePhase = state.phase.startsWith('work') ? 'work' : 'rest'
        void action
          .send({
            v: 1,
            phase: wire,
            preset: state.preset,
            ends_at: state.endsAt,
            stopped: true,
          })
          .catch(() => {
            // best-effort; a dropped stop falls back to the receiver's
            // silence timer (handover), which is the pre-fix behavior.
          })
      }
      stopBroadcasting()
      cancelSilenceTimer()
      state = {
        phase: 'idle',
        endsAt: null,
        preset: null,
        broadcasterEdPubkey: null,
        iAmBroadcaster: false,
      }
      pushSnapshot()
      if (wasBroadcaster) args.onPomodoroEnd()
    },
    teardown: () => {
      if (teardownCalled) return
      teardownCalled = true
      stopBroadcasting()
      cancelSilenceTimer()
    },
  }
}
