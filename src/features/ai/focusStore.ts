// V2-P5 — Zustand wrapper around the pure score state machine.
//
// The store holds the current machine state and the latest events emitted
// by the most recent applyJudgment() call. Components subscribe to slices:
// V2-P6 reads `lastEvents` to render the self-warning badge and broadcast
// alerts over the WebRTC data channel; V2-P8 reads `score` and the per-
// session sample tallies to render the post-session report.
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
  // V2-P8 per-session tallies for the report's focused-time percentage.
  // The audit log only records ai_warning / ai_alert events (one per
  // streak), so it cannot tell us how many ticks were actually on-task vs.
  // off-task. We count them here instead. focused_pct = onTaskSamples /
  // totalSamples (null when no samples ran — e.g. AI features off, sidecar
  // failure, or the user never declared a topic).
  totalSamples: number
  onTaskSamples: number
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
  totalSamples: 0,
  onTaskSamples: 0,

  applyJudgment: (judgment, ts) => {
    const raw = activeThresholdReader()
    const thresholds = normaliseThresholds(raw.warning, raw.alert)
    const result = step(
      get().machine,
      { severity: judgment.severity, reasoning: judgment.reasoning },
      thresholds
    )
    set((prev) => ({
      machine: result.state,
      lastEvents: result.events,
      lastSampleAt: ts ?? Date.now(),
      totalSamples: prev.totalSamples + 1,
      onTaskSamples:
        judgment.severity === 'on_task'
          ? prev.onTaskSamples + 1
          : prev.onTaskSamples,
    }))
    return result.events
  },

  reset: () =>
    set({
      machine: initialScoreMachineState(),
      lastEvents: [],
      lastSampleAt: null,
      totalSamples: 0,
      onTaskSamples: 0,
    }),
}))

// Snapshot the focus-store fields V2-P8's report generator needs. Capture
// at the TOP of `buildLeaveHandler` (before `await room.leave()` and before
// any reset) — the V2-P5 reset effect only fires when `status==='active'`,
// so the store survives through the 'ended' window, but reading up front
// decouples the report from that invariant and from a future StrictMode /
// HMR double-mount.
export type FocusSnapshot = {
  score: number
  focusedPct: number | null
}

export function snapshotFocusForReport(): FocusSnapshot {
  const s = useFocusStore.getState()
  return {
    score: s.machine.score,
    focusedPct: s.totalSamples > 0 ? s.onTaskSamples / s.totalSamples : null,
  }
}
