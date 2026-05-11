// V2-P5 → V2-P7 — Break-state store consumed by the sample loop AND the
// V2-P7 rule layer.
//
// The sample loop reads `onBreak: boolean` per tick to skip inference
// (ARCHITECTURE.md §8: "if user_on_break: skip"). The V2-P7 rule layer in
// `features/session/break.ts` reads / writes the rest of the state:
//
//   - `breakStartedAt` + `breakEndsAt`: drives the SessionView countdown
//     badge and the scheduled `endBreak` at the deadline.
//   - `lastBreakEndedAt`:    25-minute cool-down between breaks.
//   - `breaksThisSession`:   ≤ 4 breaks per session (simple total since
//                            session start; the rolling 2-hour window
//                            upgrade lands in V2-P9).
//   - `sessionStartedAt`:    anchors the per-session counter so resets at
//                            session boundaries don't bleed across the
//                            same app launch.
//
// Reset is called by SessionView's V2-P5 session-start effect, alongside
// `useFocusStore.reset()` / `useAlertsUiStore.reset()`. Without it the
// breaksThisSession counter would persist across sessions within the
// same app process.

import { create } from 'zustand'

type BreakState = {
  onBreak: boolean
  // Wall-clock ms epoch the active break started, or null when not on
  // break. Set by `startApprovedBreak`, cleared by `endBreak`.
  breakStartedAt: number | null
  // Wall-clock ms epoch the active break is scheduled to end. Drives the
  // countdown UI and is the target the rule layer's setTimeout fires on.
  breakEndsAt: number | null
  // Wall-clock ms epoch the most recent break ended (any reason — natural
  // expiry, manual end, session teardown). Drives the 25-min cool-down.
  lastBreakEndedAt: number | null
  // Total approved breaks since the current session started. The rule
  // layer caps this at 4 per session (V2-P7 spec). Reset on session start.
  breaksThisSession: number
  // Wall-clock ms epoch the current session started. Reset() seeds this
  // so the rule layer can scope quotas to "this session" rather than the
  // whole app lifetime.
  sessionStartedAt: number | null
  // Approve a break: flip onBreak, set the start/end timestamps, bump the
  // session counter. The rule layer is the only caller — components must
  // not call this directly. `endBreak` clears onBreak + records the end
  // ts; the rule-layer-side setTimeout calls it at the deadline (or the
  // user can end early, V3 polish).
  startApprovedBreak: (args: { durationSec: number; startedAt: number }) => void
  endBreak: (endedAt: number) => void
  // Called by SessionView at session-start (alongside focus/alerts resets).
  // Seeds `sessionStartedAt` so the per-session quota tracks correctly,
  // and clears any lingering break from the previous session in the same
  // app launch.
  reset: (sessionStartedAt: number | null) => void
}

export const useBreakStore = create<BreakState>((set) => ({
  onBreak: false,
  breakStartedAt: null,
  breakEndsAt: null,
  lastBreakEndedAt: null,
  breaksThisSession: 0,
  sessionStartedAt: null,
  startApprovedBreak: ({ durationSec, startedAt }) =>
    set((s) => ({
      onBreak: true,
      breakStartedAt: startedAt,
      breakEndsAt: startedAt + durationSec * 1000,
      breaksThisSession: s.breaksThisSession + 1,
    })),
  endBreak: (endedAt) =>
    set({
      onBreak: false,
      breakStartedAt: null,
      breakEndsAt: null,
      lastBreakEndedAt: endedAt,
    }),
  reset: (sessionStartedAt) =>
    set({
      onBreak: false,
      breakStartedAt: null,
      breakEndsAt: null,
      lastBreakEndedAt: null,
      breaksThisSession: 0,
      sessionStartedAt,
    }),
}))
