// V2-P5 — Zustand wrapper around the pure score state machine.
//
// The store holds the current machine state and the latest events emitted
// by the most recent applyJudgment() call. Components subscribe to slices:
// V2-P6 will read `lastEvents` to render the self-warning badge and to
// broadcast alerts over the WebRTC data channel; V2-P8 will read `score` to
// render the post-session report.
//
// Thresholds are sourced from `useSettingsStore.values` at apply-time, so
// adjusting them in Settings → AI (V2-P9) takes effect on the very next
// sample without a session restart. Defaults live in scoreMachine.ts and
// match PLAN.md §5 V2 ("2 then 4").
//
// The store is intentionally NOT persisted. Score is per-session; the score
// for the just-ended session lands in sessions.score via V2-P8's report
// generator, not via this store.

import { create } from 'zustand'

import { useSettingsStore } from '@/stores/settingsStore'

import type { Judgment } from './parseJudgment'
import {
  initialScoreMachineState,
  normaliseThresholds,
  step,
  type ScoreEvent,
  type ScoreMachineState,
} from './scoreMachine'

type FocusState = {
  machine: ScoreMachineState
  // Events emitted by the most recent applyJudgment call, in order. Empty
  // when the call produced no events (the common on_task case). Cleared on
  // reset(). Consumers should treat this as a transient "event bus": each
  // applyJudgment overwrites the previous value, so subscribers should
  // react synchronously or queue.
  lastEvents: ReadonlyArray<ScoreEvent>
  // ISO millis the last applyJudgment ran. Null until first sample.
  lastSampleAt: number | null
  applyJudgment: (j: Judgment, ts?: number) => ReadonlyArray<ScoreEvent>
  reset: () => void
}

// Indirection so unit tests can stub the settings read without spinning a
// full LazyStore. Production reads from the live useSettingsStore.
export type FocusStoreThresholdReader = () => {
  warning: unknown
  alert: unknown
}

const defaultThresholdReader: FocusStoreThresholdReader = () => {
  const v = useSettingsStore.getState().values
  return {
    warning: v.warningThreshold,
    alert: v.alertThreshold,
  }
}

let activeThresholdReader: FocusStoreThresholdReader = defaultThresholdReader

export function __setFocusStoreThresholdReader(
  reader: FocusStoreThresholdReader
): void {
  activeThresholdReader = reader
}

export function __resetFocusStoreThresholdReader(): void {
  activeThresholdReader = defaultThresholdReader
}

export const useFocusStore = create<FocusState>((set, get) => ({
  machine: initialScoreMachineState(),
  lastEvents: [],
  lastSampleAt: null,

  applyJudgment: (judgment, ts) => {
    const raw = activeThresholdReader()
    const thresholds = normaliseThresholds(raw.warning, raw.alert)
    const result = step(
      get().machine,
      { severity: judgment.severity, reasoning: judgment.reasoning },
      thresholds
    )
    set({
      machine: result.state,
      lastEvents: result.events,
      lastSampleAt: ts ?? Date.now(),
    })
    return result.events
  },

  reset: () =>
    set({
      machine: initialScoreMachineState(),
      lastEvents: [],
      lastSampleAt: null,
    }),
}))
