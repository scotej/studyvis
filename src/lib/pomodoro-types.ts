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

export type PomodoroPreset = '25/5' | '50/10'

// Public state slice the UI subscribes to. Lives here (rather than in the
// `features/session/pomodoro` controller) so `stores/pomodoroStore.ts` can
// import it without reaching into the features layer. The controller still
// re-exports it for existing consumers / tests.
export type PomodoroSnapshot = {
  phase: PomodoroPhase
  endsAt: number | null
  preset: PomodoroPreset | null
  broadcasterEdPubkey: string | null
  // Iff this peer is currently broadcasting.
  iAmBroadcaster: boolean
}
