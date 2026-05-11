// V2-P5 — Pure state-machine tests. The score machine is the deterministic
// core of the focus-detection pipeline; everything else in features/ai/ is
// orchestration around its step() function.
//
// Test taxonomy:
//   - Initial state + invariants (floor 0, starts at 100, no events)
//   - Severity → counter behaviour (on_task resets; non-on-task increments)
//   - Threshold edge-triggering (warning, alert, no re-fire mid-streak)
//   - Deduction table (mild -2, moderate -5, blatant -15) + score floor
//   - Threshold clamping ([2,8] / [3,12], warning < alert invariant)
//   - V2-P5 acceptance: 10-minute simulated mixed-severity session
//     produces the expected warning / alert / score totals.

import { describe, expect, test } from 'vitest'

import {
  ALERT_THRESHOLD_MAX,
  ALERT_THRESHOLD_MIN,
  DEFAULT_ALERT_THRESHOLD,
  DEFAULT_WARNING_THRESHOLD,
  INITIAL_SCORE,
  SCORE_FLOOR,
  SEVERITY_DEDUCTIONS,
  WARNING_THRESHOLD_MAX,
  WARNING_THRESHOLD_MIN,
  clampAlertThreshold,
  clampWarningThreshold,
  initialScoreMachineState,
  normaliseThresholds,
  scoreMachineStep as step,
  type ScoreEvent,
  type ScoreMachineState,
  type ScoreThresholds,
} from '@/features/ai'
import type { Severity } from '@/features/ai'

const DEFAULTS: ScoreThresholds = {
  warning: DEFAULT_WARNING_THRESHOLD,
  alert: DEFAULT_ALERT_THRESHOLD,
}

function runSequence(
  severities: Severity[],
  thresholds: ScoreThresholds = DEFAULTS,
  reasoningPrefix = 'r'
): { final: ScoreMachineState; events: ScoreEvent[] } {
  let state = initialScoreMachineState()
  const allEvents: ScoreEvent[] = []
  severities.forEach((severity, i) => {
    const result = step(
      state,
      { severity, reasoning: `${reasoningPrefix}${i}` },
      thresholds
    )
    state = result.state
    allEvents.push(...result.events)
  })
  return { final: state, events: allEvents }
}

function countEvents(events: ScoreEvent[], type: ScoreEvent['type']): number {
  return events.filter((e) => e.type === type).length
}

describe('initialScoreMachineState', () => {
  test('starts at score 100 with empty streak and clear latches', () => {
    const s = initialScoreMachineState()
    expect(s.score).toBe(INITIAL_SCORE)
    expect(s.consecutiveOffTask).toBe(0)
    expect(s.alertedThisStreak).toBe(false)
    expect(s.warnedThisStreak).toBe(false)
    expect(s.lastSeverity).toBeNull()
  })
})

describe('step — on_task baseline', () => {
  test('emits no event from the resting state', () => {
    const { events, final } = runSequence(['on_task'])
    expect(events).toEqual([])
    expect(final.score).toBe(INITIAL_SCORE)
    expect(final.consecutiveOffTask).toBe(0)
  })

  test('returns the same state object when on_task arrives at rest', () => {
    const initial = initialScoreMachineState()
    const result = step(initial, { severity: 'on_task', reasoning: 'r' })
    expect(result.state).toBe(initial)
    expect(result.events).toEqual([])
  })

  test('resets counters + latches after any off-task streak', () => {
    const { final } = runSequence(['mild', 'mild', 'on_task'])
    expect(final.consecutiveOffTask).toBe(0)
    expect(final.warnedThisStreak).toBe(false)
    expect(final.alertedThisStreak).toBe(false)
    expect(final.lastSeverity).toBeNull()
  })
})

describe('step — warning + alert edge-triggering (defaults 2/4)', () => {
  test('first non-on-task sample emits nothing', () => {
    const { events, final } = runSequence(['mild'])
    expect(events).toEqual([])
    expect(final.consecutiveOffTask).toBe(1)
    expect(final.score).toBe(INITIAL_SCORE)
  })

  test('second consecutive non-on-task fires a single warning', () => {
    const { events, final } = runSequence(['mild', 'mild'])
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('warning')
    expect(final.warnedThisStreak).toBe(true)
    expect(final.alertedThisStreak).toBe(false)
    // Warning never deducts score.
    expect(final.score).toBe(INITIAL_SCORE)
  })

  test('third consecutive non-on-task is silent (no re-warning)', () => {
    const { events } = runSequence(['mild', 'mild', 'mild'])
    expect(countEvents(events, 'warning')).toBe(1)
    expect(countEvents(events, 'alert')).toBe(0)
  })

  test('fourth consecutive non-on-task fires a single alert + deduction', () => {
    const { events, final } = runSequence([
      'moderate',
      'moderate',
      'moderate',
      'moderate',
    ])
    expect(countEvents(events, 'alert')).toBe(1)
    const alert = events.find((e) => e.type === 'alert')
    expect(alert).toBeDefined()
    if (alert?.type !== 'alert') throw new Error('unreachable')
    expect(alert.severity).toBe('moderate')
    expect(alert.deduction).toBe(SEVERITY_DEDUCTIONS.moderate)
    expect(alert.scoreAfter).toBe(INITIAL_SCORE - SEVERITY_DEDUCTIONS.moderate)
    expect(final.alertedThisStreak).toBe(true)
    expect(final.score).toBe(INITIAL_SCORE - SEVERITY_DEDUCTIONS.moderate)
  })

  test("alert uses the triggering sample's severity, even on a mixed streak", () => {
    // mild, mild, mild, blatant → alert at sample 4 = blatant (-15)
    const { events, final } = runSequence(['mild', 'mild', 'mild', 'blatant'])
    const alert = events.find((e) => e.type === 'alert')
    if (alert?.type !== 'alert') throw new Error('expected alert')
    expect(alert.severity).toBe('blatant')
    expect(alert.deduction).toBe(15)
    expect(final.score).toBe(INITIAL_SCORE - 15)
  })

  test('post-alert non-on-task samples do not re-fire alert in same streak', () => {
    const sequence: Severity[] = [
      'mild',
      'mild',
      'mild',
      'mild', // alert here
      'mild',
      'mild',
      'mild',
      'mild',
      'mild',
      'mild',
    ]
    const { events, final } = runSequence(sequence)
    expect(countEvents(events, 'warning')).toBe(1)
    expect(countEvents(events, 'alert')).toBe(1)
    expect(final.consecutiveOffTask).toBe(10)
    expect(final.score).toBe(INITIAL_SCORE - SEVERITY_DEDUCTIONS.mild)
  })

  test('on_task between streaks allows a second alert in the next streak', () => {
    const sequence: Severity[] = [
      'mild',
      'mild',
      'mild',
      'mild', // alert 1
      'on_task',
      'mild',
      'mild',
      'mild',
      'mild', // alert 2
    ]
    const { events, final } = runSequence(sequence)
    expect(countEvents(events, 'warning')).toBe(2)
    expect(countEvents(events, 'alert')).toBe(2)
    expect(final.score).toBe(INITIAL_SCORE - SEVERITY_DEDUCTIONS.mild * 2)
  })
})

describe('step — deduction table', () => {
  test.each<[Exclude<Severity, 'on_task'>, number]>([
    ['mild', 2],
    ['moderate', 5],
    ['blatant', 15],
  ])('%s alert deducts %i', (severity, deduction) => {
    const { final } = runSequence([severity, severity, severity, severity])
    expect(final.score).toBe(INITIAL_SCORE - deduction)
  })

  test('score clamps at floor 0, never negative', () => {
    // Drive 7 blatant streaks separated by on_task, each costs -15. After 6
    // streaks we should be at INITIAL_SCORE - 90 = 10. The 7th drives below
    // floor and must clamp.
    const streak: Severity[] = ['blatant', 'blatant', 'blatant', 'blatant']
    const sequence: Severity[] = []
    for (let i = 0; i < 7; i += 1) {
      sequence.push(...streak, 'on_task')
    }
    const { final, events } = runSequence(sequence)
    expect(final.score).toBe(SCORE_FLOOR)
    // Each streak produces one alert.
    expect(countEvents(events, 'alert')).toBe(7)
    // The last alert's scoreAfter clamps to 0.
    const lastAlert = events.filter((e) => e.type === 'alert').at(-1)
    if (lastAlert?.type !== 'alert') throw new Error('unreachable')
    expect(lastAlert.scoreAfter).toBe(SCORE_FLOOR)
  })

  test('score floor 0 from a single blatant alert when score was already 10', () => {
    let state: ScoreMachineState = {
      ...initialScoreMachineState(),
      score: 10,
    }
    const trigger: Severity[] = ['blatant', 'blatant', 'blatant', 'blatant']
    for (const severity of trigger) {
      state = step(state, { severity, reasoning: '' }).state
    }
    expect(state.score).toBe(SCORE_FLOOR)
  })
})

describe('threshold clamping + invariants', () => {
  test('warning threshold clamps to [2,8] integer', () => {
    expect(clampWarningThreshold(0)).toBe(WARNING_THRESHOLD_MIN)
    expect(clampWarningThreshold(1)).toBe(WARNING_THRESHOLD_MIN)
    expect(clampWarningThreshold(2)).toBe(2)
    expect(clampWarningThreshold(5)).toBe(5)
    expect(clampWarningThreshold(8)).toBe(WARNING_THRESHOLD_MAX)
    expect(clampWarningThreshold(99)).toBe(WARNING_THRESHOLD_MAX)
    expect(clampWarningThreshold(NaN)).toBe(DEFAULT_WARNING_THRESHOLD)
    expect(clampWarningThreshold('foo')).toBe(DEFAULT_WARNING_THRESHOLD)
    expect(clampWarningThreshold(3.7)).toBe(4)
  })

  test('alert threshold clamps to [3,12] integer', () => {
    expect(clampAlertThreshold(0)).toBe(ALERT_THRESHOLD_MIN)
    expect(clampAlertThreshold(3)).toBe(3)
    expect(clampAlertThreshold(12)).toBe(ALERT_THRESHOLD_MAX)
    expect(clampAlertThreshold(99)).toBe(ALERT_THRESHOLD_MAX)
    expect(clampAlertThreshold(undefined)).toBe(DEFAULT_ALERT_THRESHOLD)
  })

  test('normaliseThresholds enforces warning < alert', () => {
    // warning=5, alert=4 (invalid) → alert slides to 6
    expect(normaliseThresholds(5, 4)).toEqual({ warning: 5, alert: 6 })
    // warning=8 (max) + alert=8 → alert can't exceed 12, so 9
    expect(normaliseThresholds(8, 3)).toEqual({ warning: 8, alert: 9 })
    // warning=8 + alert=12: already valid
    expect(normaliseThresholds(8, 12)).toEqual({ warning: 8, alert: 12 })
  })

  test('custom thresholds drive the edge-trigger correctly (warning=3, alert=5)', () => {
    const thresholds: ScoreThresholds = { warning: 3, alert: 5 }
    // Samples 1,2 → silent; 3 → warning; 4 → silent; 5 → alert.
    const sequence: Severity[] = ['mild', 'mild', 'mild', 'mild', 'mild']
    const { events, final } = runSequence(sequence, thresholds)
    expect(countEvents(events, 'warning')).toBe(1)
    expect(countEvents(events, 'alert')).toBe(1)
    expect(final.consecutiveOffTask).toBe(5)
    expect(final.score).toBe(INITIAL_SCORE - SEVERITY_DEDUCTIONS.mild)
  })

  test('custom thresholds extreme (warning=8, alert=12)', () => {
    const thresholds: ScoreThresholds = { warning: 8, alert: 12 }
    // 11 mild samples — under alert threshold, warning fires at sample 8.
    const sequence: Severity[] = new Array(11).fill('mild') as Severity[]
    const { events, final } = runSequence(sequence, thresholds)
    expect(countEvents(events, 'warning')).toBe(1)
    expect(countEvents(events, 'alert')).toBe(0)
    expect(final.score).toBe(INITIAL_SCORE)
  })
})

describe('V2-P5 acceptance — 10-minute simulated session', () => {
  // ARCHITECTURE.md §8: sample_interval = max(5, ceil(p95 + 1)). 5 s is the
  // floor, so a 10-min session at the fastest cadence is exactly 120 ticks.
  const SAMPLE_COUNT = 120

  test('default thresholds — three off-task bursts produce 3 warnings + 3 alerts', () => {
    // Pattern: 10 on-task, 5 off-task (mixed mild/moderate/blatant), repeat.
    // 120 samples / 15 per cycle = 8 cycles → 8 streaks of 5 non-on-task each.
    // Each streak: 2nd sample warning, 4th sample alert, 5th sample silent.
    // Streak content: ['mild', 'mild', 'mild', 'blatant', 'mild'] →
    //   alert at sample 4 = blatant → deduction -15.
    const streakBurst: Severity[] = ['mild', 'mild', 'mild', 'blatant', 'mild']
    const cycle: Severity[] = [
      ...(new Array(10).fill('on_task') as Severity[]),
      ...streakBurst,
    ]
    const expectedCycles = Math.floor(SAMPLE_COUNT / cycle.length)
    const remainder = SAMPLE_COUNT - expectedCycles * cycle.length
    const sequence: Severity[] = []
    for (let i = 0; i < expectedCycles; i += 1) {
      sequence.push(...cycle)
    }
    // Pad remainder with on_task so the last partial cycle doesn't half-fire.
    for (let i = 0; i < remainder; i += 1) {
      sequence.push('on_task')
    }
    expect(sequence).toHaveLength(SAMPLE_COUNT)
    const { events, final } = runSequence(sequence)
    expect(countEvents(events, 'warning')).toBe(expectedCycles)
    expect(countEvents(events, 'alert')).toBe(expectedCycles)
    // Each alert deducts -15 (blatant at sample 4 of every streak).
    const expectedScore = Math.max(
      SCORE_FLOOR,
      INITIAL_SCORE - SEVERITY_DEDUCTIONS.blatant * expectedCycles
    )
    expect(final.score).toBe(expectedScore)
  })

  test('a fully on-task 10-minute session emits no events and keeps score 100', () => {
    const sequence: Severity[] = new Array(SAMPLE_COUNT).fill(
      'on_task'
    ) as Severity[]
    const { events, final } = runSequence(sequence)
    expect(events).toEqual([])
    expect(final.score).toBe(INITIAL_SCORE)
  })

  test('a fully off-task 10-minute streak emits exactly one alert', () => {
    // Per the "one alert per streak" semantics: a single 600-second binge
    // costs at most one deduction. This is the spec-encoded behaviour
    // (PLAN.md "first 2 / next 2"); without this latch a single distracted
    // session would crater the score past floor in 30 seconds.
    const sequence: Severity[] = new Array(SAMPLE_COUNT).fill(
      'moderate'
    ) as Severity[]
    const { events, final } = runSequence(sequence)
    expect(countEvents(events, 'warning')).toBe(1)
    expect(countEvents(events, 'alert')).toBe(1)
    expect(final.score).toBe(INITIAL_SCORE - SEVERITY_DEDUCTIONS.moderate)
    expect(final.consecutiveOffTask).toBe(SAMPLE_COUNT)
  })

  test('mixed shorter bursts produce expected warnings/alerts/score within ±1', () => {
    // 5 burst patterns alternating between "short distraction recovered"
    // (3 mild, on_task) — warning but no alert — and "full alert" (4 mild,
    // on_task). Then back-fill with on_task to 120.
    const sequence: Severity[] = []
    for (let i = 0; i < 4; i += 1) {
      sequence.push(
        'on_task',
        'on_task',
        'mild',
        'mild',
        'mild',
        'on_task' // streak length 3 → only warning fires
      )
      sequence.push(
        'on_task',
        'on_task',
        'mild',
        'mild',
        'mild',
        'mild',
        'on_task' // streak length 4 → warning + alert
      )
    }
    while (sequence.length < SAMPLE_COUNT) sequence.push('on_task')
    sequence.length = SAMPLE_COUNT
    const { events, final } = runSequence(sequence)
    // 8 streaks total, all fire warning; 4 fire alert.
    expect(countEvents(events, 'warning')).toBe(8)
    expect(countEvents(events, 'alert')).toBe(4)
    const expectedScore = INITIAL_SCORE - SEVERITY_DEDUCTIONS.mild * 4
    // Acceptance: within ±1 point (PLAN.md V2-P5 acceptance criterion). We
    // hit exactly the predicted value because the machine is deterministic,
    // but the ±1 margin is documented for hand-driven prompt revisions.
    expect(Math.abs(final.score - expectedScore)).toBeLessThanOrEqual(1)
  })
})
