// Shared types for the V1 Pomodoro feature. Lives in `lib/` so both the
// `features/session/pomodoro.ts` controller and the `components/SessionTimer`
// presentational component can import them without violating the
// components-may-not-import-from-features layering rule (CLAUDE.md house
// rules).

export type PomodoroPhase =
  | 'idle'
  | 'work-25'
  | 'rest-5'
  | 'work-50'
  | 'rest-10'
  // N5 — custom-duration phases. The 5-state-per-preset model the UI labels
  // off carries a single custom pair; the exact minute split rides in the
  // snapshot's `workMs`/`restMs`, not the phase name.
  | 'work-custom'
  | 'rest-custom'

export type PomodoroPreset = '25/5' | '50/10' | 'custom'

// N5 — bounds for a custom split (minutes). Chosen to cover the common
// alternatives (45/15, 90/20) while staying sane for a body-doubling session.
export const CUSTOM_WORK_MIN = 5
export const CUSTOM_WORK_MAX = 120
export const CUSTOM_REST_MIN = 1
export const CUSTOM_REST_MAX = 60

// N5 — clamp a (work, rest) minute pair to the custom bounds. Used by the UI
// before broadcasting so an out-of-range typed value can never reach the wire.
// Non-finite / sub-integer inputs fall back to the lower bound.
export function clampCustomMinutes(
  workMin: number,
  restMin: number
): {
  workMin: number
  restMin: number
} {
  const clamp = (v: number, lo: number, hi: number): number => {
    if (!Number.isFinite(v)) return lo
    return Math.min(hi, Math.max(lo, Math.round(v)))
  }
  return {
    workMin: clamp(workMin, CUSTOM_WORK_MIN, CUSTOM_WORK_MAX),
    restMin: clamp(restMin, CUSTOM_REST_MIN, CUSTOM_REST_MAX),
  }
}

// N5 — a user-initiated start carries either a legacy preset or a custom
// split. `custom` requires the explicit durations (ms). Lives here so the
// presentational `components/SessionTimer` can type its `onStart` without
// importing from the `features` layer.
export type PomodoroStartArgs =
  | { preset: '25/5' | '50/10' }
  | { preset: 'custom'; workMs: number; restMs: number }

// Public state slice the UI subscribes to. Lives here (rather than in the
// `features/session/pomodoro` controller) so `stores/pomodoroStore.ts` can
// import it without reaching into the features layer. The controller still
// re-exports it for existing consumers / tests.
export type PomodoroSnapshot = {
  phase: PomodoroPhase
  endsAt: number | null
  preset: PomodoroPreset | null
  // N5 — explicit phase durations (ms). Non-null whenever a Pomodoro is
  // active so the UI label + the next-phase transition use the real split,
  // including custom durations. For the legacy presets these mirror
  // PRESET_DURATIONS; for `custom` they carry the user's chosen split.
  workMs: number | null
  restMs: number | null
  broadcasterEdPubkey: string | null
  // Iff this peer is currently broadcasting.
  iAmBroadcaster: boolean
}
