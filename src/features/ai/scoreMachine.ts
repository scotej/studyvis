// V2-P5 — Pure, deterministic per-user focus-score state machine.
//
// ARCHITECTURE.md §8 "Score mapping":
//   on_task    → 0 deduction
//   mild       → -2  (after alert threshold)
//   moderate   → -5  (after alert threshold)
//   blatant    → -15 (after alert threshold)
//
// Threshold semantics (PLAN.md §5 V2 + ARCHITECTURE.md §8):
//   - One counter over CONSECUTIVE non-on-task samples (the "off-task streak").
//   - At warningThreshold (default 2) → emit a self-only "warning" event.
//   - At alertThreshold   (default 4) → emit "alert" + deduct deduction[severity].
//   - One warning + one alert + one deduction PER STREAK. After the alert
//     fires, additional non-on-task samples extend the streak silently — this
//     is what the `alertedThisStreak` latch encodes. The latch matches the
//     "first 2 / next 2" framing in PLAN.md (single peer-alert per off-task
//     bout) and prevents a single 10-min distraction from draining the score
//     past floor.
//   - `on_task` resets the streak: counter → 0, latch cleared, lastSeverity
//     forgotten.
//   - The deduction's severity = the severity of the sample that crossed the
//     alert threshold, not the max/min/most-recent within the streak. With
//     warning < alert this is always the alert-tick's severity (the streak's
//     entries before the alert-tick may or may not match — the V2-P5 prompt
//     reads "consecutive non-on-task" without partitioning by severity).
//
// Threshold ranges (ARCHITECTURE.md §8): warning in [2, 8], alert in [3, 12],
// constraint warning < alert. The state machine clamps inputs at construction
// time so a misconfigured settings.json can't crash the machine.
//
// Score is integer in [0, 100]. Deductions clamp at 0.
//
// This module is intentionally framework-free: no React, no Zustand, no
// Tauri. The orchestrator (sampleLoop.ts) and the store (focusStore.ts)
// import the pure step() function — that boundary is what makes the V2-P5
// acceptance test (a 10-minute simulated severity stream) trivially
// deterministic.

import type { Severity } from './parseJudgment'

export const INITIAL_SCORE = 100
export const SCORE_FLOOR = 0

// Default thresholds match PLAN.md §5 V2 ("first 2 … next 2") and
// ARCHITECTURE.md §8 score-mapping rows. V2-P9 wires the Settings → AI sliders
// that let the user customize within the ranges below.
export const DEFAULT_WARNING_THRESHOLD = 2
export const DEFAULT_ALERT_THRESHOLD = 4

export const WARNING_THRESHOLD_MIN = 2
export const WARNING_THRESHOLD_MAX = 8
export const ALERT_THRESHOLD_MIN = 3
export const ALERT_THRESHOLD_MAX = 12

// Deduction table keyed by severity. on_task is included for exhaustive
// coverage but is never used (an on_task sample resets the streak instead
// of triggering deduction).
export const SEVERITY_DEDUCTIONS: Record<Severity, number> = {
  on_task: 0,
  mild: 2,
  moderate: 5,
  blatant: 15,
}

export type ScoreMachineState = {
  score: number
  // Length of the current off-task streak. Reset to 0 on every on_task
  // sample. Increments by 1 on every non-on-task sample.
  consecutiveOffTask: number
  // True once the alert event has fired this streak. Subsequent non-on-task
  // samples in the same streak extend `consecutiveOffTask` but emit no new
  // events. Cleared on on_task.
  alertedThisStreak: boolean
  // True once the warning event has fired this streak (latched the same way
  // as alertedThisStreak). Without this latch, raising warningThreshold to
  // ≥3 means consecutive samples 2 and 3 (under default alert=4) both fire
  // warning. The PLAN.md "first 2 / next 2" framing reads as one warning
  // per streak.
  warnedThisStreak: boolean
  // Most recent non-on-task severity observed; null after on_task. Used
  // only for debugging / test introspection — never affects the threshold
  // logic.
  lastSeverity: Severity | null
}

export type ScoreThresholds = {
  warning: number
  alert: number
}

export type ScoreEvent =
  | {
      type: 'warning'
      severity: Exclude<Severity, 'on_task'>
      reasoning: string
    }
  | {
      type: 'alert'
      severity: Exclude<Severity, 'on_task'>
      reasoning: string
      deduction: number
      // The score the user dropped TO after deduction. Convenient for
      // downstream code that wants to emit a single broadcast payload.
      scoreAfter: number
    }

export type StepInput = {
  severity: Severity
  reasoning: string
}

export type StepResult = {
  state: ScoreMachineState
  events: ScoreEvent[]
}

export function initialScoreMachineState(): ScoreMachineState {
  return {
    score: INITIAL_SCORE,
    consecutiveOffTask: 0,
    alertedThisStreak: false,
    warnedThisStreak: false,
    lastSeverity: null,
  }
}

export function clampWarningThreshold(n: unknown): number {
  return clampInt(
    n,
    WARNING_THRESHOLD_MIN,
    WARNING_THRESHOLD_MAX,
    DEFAULT_WARNING_THRESHOLD
  )
}

export function clampAlertThreshold(n: unknown): number {
  return clampInt(
    n,
    ALERT_THRESHOLD_MIN,
    ALERT_THRESHOLD_MAX,
    DEFAULT_ALERT_THRESHOLD
  )
}

// Apply both clamps AND the warning < alert invariant. If a misconfigured
// settings.json supplies warning ≥ alert, we slide the alert up to
// warning+1 (still bounded by ALERT_THRESHOLD_MAX) so the warning event
// always fires strictly before the alert.
export function normaliseThresholds(
  warning: unknown,
  alert: unknown
): ScoreThresholds {
  const w = clampWarningThreshold(warning)
  let a = clampAlertThreshold(alert)
  if (a <= w) {
    a = Math.min(w + 1, ALERT_THRESHOLD_MAX)
  }
  return { warning: w, alert: a }
}

function clampInt(
  value: unknown,
  min: number,
  max: number,
  fallback: number
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  const rounded = Math.round(value)
  if (rounded < min) return min
  if (rounded > max) return max
  return rounded
}

export function step(
  prev: ScoreMachineState,
  input: StepInput,
  thresholds: ScoreThresholds = {
    warning: DEFAULT_WARNING_THRESHOLD,
    alert: DEFAULT_ALERT_THRESHOLD,
  }
): StepResult {
  const { severity, reasoning } = input

  if (severity === 'on_task') {
    if (
      prev.consecutiveOffTask === 0 &&
      !prev.alertedThisStreak &&
      !prev.warnedThisStreak &&
      prev.lastSeverity === null
    ) {
      // Already in the resting state; return the same object so subscribers
      // don't re-render on a no-op.
      return { state: prev, events: [] }
    }
    return {
      state: {
        score: prev.score,
        consecutiveOffTask: 0,
        alertedThisStreak: false,
        warnedThisStreak: false,
        lastSeverity: null,
      },
      events: [],
    }
  }

  const nextCount = prev.consecutiveOffTask + 1
  const events: ScoreEvent[] = []
  let nextScore = prev.score
  let warned = prev.warnedThisStreak
  let alerted = prev.alertedThisStreak

  // Edge-triggered warning: fires the first time the streak length is at or
  // above the warning threshold (which under defaults is exactly count===2).
  // The latch prevents re-firing if the alert threshold is higher than the
  // warning threshold and we cross both on the same streak (sample-by-sample
  // counters under default thresholds: 1 — silent, 2 — warning, 3 — silent,
  // 4 — alert).
  if (!warned && nextCount >= thresholds.warning) {
    warned = true
    events.push({
      type: 'warning',
      severity: severity as Exclude<Severity, 'on_task'>,
      reasoning,
    })
  }

  // Edge-triggered alert: fires once when the streak first crosses the alert
  // threshold. Latches so subsequent non-on-task samples in the same streak
  // don't re-fire (preventing a single long distraction from draining the
  // score past floor in one streak).
  if (!alerted && nextCount >= thresholds.alert) {
    alerted = true
    const deduction = SEVERITY_DEDUCTIONS[severity]
    nextScore = Math.max(SCORE_FLOOR, prev.score - deduction)
    events.push({
      type: 'alert',
      severity: severity as Exclude<Severity, 'on_task'>,
      reasoning,
      deduction,
      scoreAfter: nextScore,
    })
  }

  return {
    state: {
      score: nextScore,
      consecutiveOffTask: nextCount,
      alertedThisStreak: alerted,
      warnedThisStreak: warned,
      lastSeverity: severity,
    },
    events,
  }
}
