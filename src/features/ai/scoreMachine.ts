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

// A3 — confidence floor for acting on an off-task judgment. When the model
// reports an off-task severity but its `on_topic_confidence` is at or above
// this floor (i.e. it's confident the user is ON topic) the off-task signal
// is too weak to trust, so the sample is treated as UNCERTAIN: it neither
// extends the off-task streak nor counts toward focused-time %. The doc
// guidance is "false positives are worse than false negatives" — a shaky
// off-task call should not nudge or flag the user.
//
// Default 0.6: with the V2 prompt, `on_topic_confidence` is the model's
// confidence the user is on-topic, so an off_task verdict carrying ≥0.6
// on-topic confidence is self-contradictory enough to discard. Chosen in the
// suggested 0.55–0.65 band and deliberately mild: a confident off-task call
// (low on_topic_confidence) is unaffected, so steady-state behaviour for a
// genuinely distracted user is unchanged. 0 disables the gate.
export const DEFAULT_CONFIDENCE_FLOOR = 0.6
export const CONFIDENCE_FLOOR_MIN = 0
export const CONFIDENCE_FLOOR_MAX = 0.9

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

// A2/A3 — `'uncertain'` is an INTERNAL-only severity the score machine accepts
// for samples it must not act on: a malformed/empty model response (A2) or a
// low-confidence off-task call below the floor (A3). It never reaches the
// signed `ai-alert` wire (which only carries mild/moderate/blatant), the audit
// event vocabulary, or the report — it's consumed entirely inside step() +
// focusStore. An uncertain sample is the explicit "skip" outcome: it neither
// resets the off-task streak nor extends it.
export type InternalSeverity = Severity | 'uncertain'

export type StepInput = {
  severity: InternalSeverity
  reasoning: string
  // A3 — the model's reported on-topic confidence ∈ [0,1]. Optional so callers
  // that already resolved an `'uncertain'` severity (A2) don't have to supply
  // one. When present alongside an off-task severity, step() applies the
  // confidence floor below.
  onTopicConfidence?: number
}

export type StepResult = {
  state: ScoreMachineState
  events: ScoreEvent[]
  // A2/A3 — true when this sample was treated as uncertain (a skip): the
  // streak was left untouched and no events fired. focusStore reads this to
  // tally skipped samples separately from on-task / off-task ones so an
  // uncertain sample never inflates (or deflates) focused-time %.
  uncertain: boolean
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

// Clamp the confidence floor into [0, max]. Garbage / out-of-range values
// collapse to the documented default so an unvalidated settings.json can't
// disable the gate by accident or push it past 1.
export function clampConfidenceFloor(n: unknown): number {
  if (typeof n !== 'number' || !Number.isFinite(n)) {
    return DEFAULT_CONFIDENCE_FLOOR
  }
  if (n < CONFIDENCE_FLOOR_MIN) return CONFIDENCE_FLOOR_MIN
  if (n > CONFIDENCE_FLOOR_MAX) return CONFIDENCE_FLOOR_MAX
  return n
}

export function step(
  prev: ScoreMachineState,
  input: StepInput,
  thresholds: ScoreThresholds = {
    warning: DEFAULT_WARNING_THRESHOLD,
    alert: DEFAULT_ALERT_THRESHOLD,
  },
  // A3 — confidence floor. An off-task severity whose `on_topic_confidence` is
  // at or above this floor is downgraded to uncertain (a skip). Defaults to
  // the documented floor; pass 0 to disable the gate.
  confidenceFloor: number = DEFAULT_CONFIDENCE_FLOOR
): StepResult {
  // Defensive normalisation — step() is a public API (re-exported as
  // scoreMachineStep), so a caller passing thresholds straight from
  // unvalidated settings.json can't accidentally produce
  // warning≥alert or out-of-range values that would fire alert on the
  // first sample. Cheap call; on already-valid inputs it's a no-op.
  const safeThresholds = normaliseThresholds(
    thresholds.warning,
    thresholds.alert
  )
  const safeFloor = clampConfidenceFloor(confidenceFloor)
  const { severity, reasoning } = input

  // A2 — an uncertain sample (malformed/empty response, or already-resolved
  // skip) leaves the streak and latches exactly as they were. It is NOT an
  // on_task reset (a real off-task bout in progress must survive a flaky
  // sample) and NOT an off-task increment (it can't trigger a warning/alert).
  if (severity === 'uncertain') {
    return { state: prev, events: [], uncertain: true }
  }

  // A3 — a confident off-task call is one carrying LOW on-topic confidence.
  // When the model reports an off-task severity but is still ≥floor confident
  // the user is on topic, the off-task signal is too weak to act on: treat it
  // as uncertain rather than extend the streak (false positives are worse than
  // false negatives).
  if (
    severity !== 'on_task' &&
    typeof input.onTopicConfidence === 'number' &&
    Number.isFinite(input.onTopicConfidence) &&
    safeFloor > 0 &&
    input.onTopicConfidence >= safeFloor
  ) {
    return { state: prev, events: [], uncertain: true }
  }

  if (severity === 'on_task') {
    if (
      prev.consecutiveOffTask === 0 &&
      !prev.alertedThisStreak &&
      !prev.warnedThisStreak &&
      prev.lastSeverity === null
    ) {
      // Already in the resting state; return the same object so subscribers
      // don't re-render on a no-op.
      return { state: prev, events: [], uncertain: false }
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
      uncertain: false,
    }
  }

  // Past the uncertain + on_task guards, `severity` is a confident off-task
  // call: one of mild / moderate / blatant.
  const offTask = severity as Exclude<Severity, 'on_task'>
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
  if (!warned && nextCount >= safeThresholds.warning) {
    warned = true
    events.push({
      type: 'warning',
      severity: offTask,
      reasoning,
    })
  }

  // Edge-triggered alert: fires once when the streak first crosses the alert
  // threshold. Latches so subsequent non-on-task samples in the same streak
  // don't re-fire (preventing a single long distraction from draining the
  // score past floor in one streak).
  if (!alerted && nextCount >= safeThresholds.alert) {
    alerted = true
    const deduction = SEVERITY_DEDUCTIONS[offTask]
    nextScore = Math.max(SCORE_FLOOR, prev.score - deduction)
    events.push({
      type: 'alert',
      severity: offTask,
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
      lastSeverity: offTask,
    },
    events,
    uncertain: false,
  }
}
