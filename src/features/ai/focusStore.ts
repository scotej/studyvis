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

import { isUncertainVerdict, type SampleVerdict } from './parseJudgment'
import {
  clampConfidenceFloor,
  initialScoreMachineState,
  normaliseThresholds,
  step,
  type InternalSeverity,
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
  //
  // A2/A3 — uncertain samples (malformed/empty responses, or low-confidence
  // off-task calls below the floor) are counted in `skippedSamples` and
  // EXCLUDED from `totalSamples`/`onTaskSamples`, so an uncertain sample never
  // inflates or deflates focused-time %. `totalSamples` is only confident
  // judgments.
  totalSamples: number
  onTaskSamples: number
  skippedSamples: number
  applyJudgment: (j: SampleVerdict, ts?: number) => ReadonlyArray<ScoreEvent>
  reset: () => void
}

// Indirection so unit tests can stub the settings read without spinning a
// full LazyStore. Production reads from the live useSettingsStore.
export type FocusStoreThresholdReader = () => {
  warning: unknown
  alert: unknown
  // A3 — the off-task confidence floor. Read per-apply so a mid-session
  // Settings → AI slider move takes effect on the next sample, same as the
  // warning/alert thresholds.
  confidenceFloor: unknown
}

const defaultThresholdReader: FocusStoreThresholdReader = () => {
  const v = useSettingsStore.getState().values
  return {
    warning: v.warningThreshold,
    alert: v.alertThreshold,
    confidenceFloor: v.offTaskConfidenceFloor,
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
  skippedSamples: 0,

  applyJudgment: (verdict, ts) => {
    const raw = activeThresholdReader()
    const thresholds = normaliseThresholds(raw.warning, raw.alert)
    const confidenceFloor = clampConfidenceFloor(raw.confidenceFloor)
    // A2 — an uncertain verdict (parse fallback) feeds the score machine as the
    // internal `'uncertain'` severity so it skips the streak; A3 — a confident
    // off-task call's `on_topic_confidence` gates the streak via the floor.
    const severity: InternalSeverity = isUncertainVerdict(verdict)
      ? 'uncertain'
      : verdict.severity
    const reasoning = isUncertainVerdict(verdict)
      ? `uncertain: ${verdict.reason}`
      : verdict.reasoning
    const onTopicConfidence = isUncertainVerdict(verdict)
      ? undefined
      : verdict.on_topic_confidence
    const result = step(
      get().machine,
      { severity, reasoning, onTopicConfidence },
      thresholds,
      confidenceFloor
    )
    set((prev) => ({
      machine: result.state,
      lastEvents: result.events,
      lastSampleAt: ts ?? Date.now(),
      // Uncertain (and A3-downgraded) samples are excluded from the focused-
      // time tallies and counted separately.
      totalSamples: result.uncertain
        ? prev.totalSamples
        : prev.totalSamples + 1,
      onTaskSamples:
        !result.uncertain && severity === 'on_task'
          ? prev.onTaskSamples + 1
          : prev.onTaskSamples,
      skippedSamples: result.uncertain
        ? prev.skippedSamples + 1
        : prev.skippedSamples,
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
      skippedSamples: 0,
    }),
}))

// Snapshot the focus-store fields V2-P8's report generator needs. Capture
// at the TOP of `buildLeaveHandler` (before `await room.leave()` and before
// any reset) — the V2-P5 reset effect only fires when `status==='active'`,
// so the store survives through the 'ended' window, but reading up front
// decouples the report from that invariant and from a future StrictMode /
// HMR double-mount.
export type FocusSnapshot = {
  // R1 — null when no confident sample ran (AI off, or a session of pure
  // parse failures where every tick was skipped/uncertain). `totalSamples`
  // already excludes uncertain/skipped samples (A2/A3), so this is the single
  // gate: 0 confident samples → unscored, not a fabricated 100. Persisting a
  // null keeps statsData.averageScore honest and lets the Report render its
  // no-AI state instead of a fake 100/100 gauge.
  score: number | null
  focusedPct: number | null
  // #47 D5 — data-quality counts persisted to the sessions row so the report
  // can say how much of the session the focused-time % actually saw. Null
  // when AI never ran a single check (off / no model), so an AI-off session
  // doesn't render as "0 checks skipped".
  confidentSamples: number | null
  skippedSamples: number | null
}

export function snapshotFocusForReport(): FocusSnapshot {
  const s = useFocusStore.getState()
  const scored = s.totalSamples > 0
  const ranAnyCheck = s.totalSamples > 0 || s.skippedSamples > 0
  return {
    score: scored ? s.machine.score : null,
    focusedPct: scored ? s.onTaskSamples / s.totalSamples : null,
    confidentSamples: ranAnyCheck ? s.totalSamples : null,
    skippedSamples: ranAnyCheck ? s.skippedSamples : null,
  }
}
