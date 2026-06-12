// V2-P5 — focusStore wraps the pure scoreMachine and sources thresholds
// from useSettingsStore at apply-time. These tests verify the Zustand
// surface + the settings-driven threshold flow without touching React.

import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import {
  DEFAULT_ALERT_THRESHOLD,
  DEFAULT_WARNING_THRESHOLD,
  INITIAL_SCORE,
  __resetFocusStoreThresholdReader,
  __setFocusStoreThresholdReader,
  initialScoreMachineState,
  useFocusStore,
} from '@/features/ai'
import type { Judgment, SampleVerdict, UncertainVerdict } from '@/features/ai'
import { snapshotFocusForReport } from '@/features/ai/focusStore'

const UNCERTAIN: UncertainVerdict = { kind: 'uncertain', reason: 'parse fail' }

function resetStore(): void {
  useFocusStore.setState({
    machine: initialScoreMachineState(),
    lastEvents: [],
    lastSampleAt: null,
    totalSamples: 0,
    onTaskSamples: 0,
    skippedSamples: 0,
  })
}

function makeJudgment(
  severity: Judgment['severity'],
  reasoning = 'test reasoning'
): Judgment {
  return { severity, reasoning, on_topic_confidence: 0.5 }
}

describe('useFocusStore', () => {
  beforeEach(() => {
    resetStore()
    __resetFocusStoreThresholdReader()
  })
  afterEach(() => {
    __resetFocusStoreThresholdReader()
  })

  test('starts in the resting state', () => {
    const s = useFocusStore.getState()
    expect(s.machine.score).toBe(INITIAL_SCORE)
    expect(s.machine.consecutiveOffTask).toBe(0)
    expect(s.lastEvents).toEqual([])
    expect(s.lastSampleAt).toBeNull()
  })

  test('applyJudgment for on_task is a no-op + stamps lastSampleAt', () => {
    const before = useFocusStore.getState().machine
    const ts = 1_700_000_000_000
    const events = useFocusStore
      .getState()
      .applyJudgment(makeJudgment('on_task'), ts)
    expect(events).toEqual([])
    const after = useFocusStore.getState()
    expect(after.machine).toBe(before)
    expect(after.lastSampleAt).toBe(ts)
  })

  test('emits a single warning event at sample 2 of a streak', () => {
    const state = useFocusStore.getState()
    state.applyJudgment(makeJudgment('mild', 'a'))
    const events = state.applyJudgment(makeJudgment('mild', 'b'))
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('warning')
    if (events[0].type === 'warning') {
      expect(events[0].reasoning).toBe('b')
    }
    // Store's lastEvents reflects the latest call only.
    expect(useFocusStore.getState().lastEvents).toEqual(events)
  })

  test('emits alert + deduction at sample 4 of a streak', () => {
    const state = useFocusStore.getState()
    state.applyJudgment(makeJudgment('moderate'))
    state.applyJudgment(makeJudgment('moderate'))
    state.applyJudgment(makeJudgment('moderate'))
    const events = state.applyJudgment(makeJudgment('moderate'))
    expect(events).toHaveLength(1)
    if (events[0].type !== 'alert') throw new Error('expected alert')
    expect(events[0].severity).toBe('moderate')
    expect(events[0].deduction).toBe(5)
    expect(useFocusStore.getState().machine.score).toBe(INITIAL_SCORE - 5)
  })

  test('threshold reader supplies user-overridden values per call', () => {
    let warning = 3
    let alert = 5
    __setFocusStoreThresholdReader(() => ({
      warning,
      alert,
      confidenceFloor: 0,
    }))
    const state = useFocusStore.getState()
    // With warning=3/alert=5, samples 1,2 → silent; 3 → warning; 4 → silent;
    // 5 → alert.
    for (let i = 0; i < 2; i += 1) {
      const events = state.applyJudgment(makeJudgment('mild'))
      expect(events).toEqual([])
    }
    const warned = state.applyJudgment(makeJudgment('mild'))
    expect(warned[0]?.type).toBe('warning')
    state.applyJudgment(makeJudgment('mild'))
    const alerted = state.applyJudgment(makeJudgment('mild'))
    expect(alerted[0]?.type).toBe('alert')

    // Mid-session threshold change takes effect on the NEXT sample. We move
    // the warning threshold up to 8 and verify the next post-on_task streak
    // doesn't fire at sample 2.
    warning = 8
    alert = 12
    state.applyJudgment(makeJudgment('on_task'))
    expect(useFocusStore.getState().machine.consecutiveOffTask).toBe(0)
    const first = state.applyJudgment(makeJudgment('mild'))
    const second = state.applyJudgment(makeJudgment('mild'))
    expect(first).toEqual([])
    expect(second).toEqual([])
    expect(useFocusStore.getState().machine.consecutiveOffTask).toBe(2)
  })

  test('threshold reader returning garbage falls back to defaults', () => {
    __setFocusStoreThresholdReader(() => ({
      warning: 'not a number',
      alert: undefined,
      confidenceFloor: 0,
    }))
    const state = useFocusStore.getState()
    state.applyJudgment(makeJudgment('mild'))
    const warned = state.applyJudgment(makeJudgment('mild'))
    expect(warned[0]?.type).toBe('warning')
    // Effective thresholds were the defaults — 4th sample triggers alert.
    state.applyJudgment(makeJudgment('mild'))
    const alerted = state.applyJudgment(makeJudgment('mild'))
    expect(alerted[0]?.type).toBe('alert')
    // Verify the implementation uses the documented defaults rather than
    // some other constant.
    expect(DEFAULT_WARNING_THRESHOLD).toBe(2)
    expect(DEFAULT_ALERT_THRESHOLD).toBe(4)
  })

  test('reset() returns to initial state', () => {
    const state = useFocusStore.getState()
    state.applyJudgment(makeJudgment('blatant'))
    state.applyJudgment(makeJudgment('blatant'))
    state.applyJudgment(makeJudgment('blatant'))
    state.applyJudgment(makeJudgment('blatant'))
    expect(useFocusStore.getState().machine.score).toBeLessThan(INITIAL_SCORE)
    state.reset()
    const s = useFocusStore.getState()
    expect(s.machine.score).toBe(INITIAL_SCORE)
    expect(s.lastEvents).toEqual([])
    expect(s.lastSampleAt).toBeNull()
    expect(s.totalSamples).toBe(0)
    expect(s.onTaskSamples).toBe(0)
  })

  test('applyJudgment tallies on_task vs off-task samples for the V2-P8 report', () => {
    const state = useFocusStore.getState()
    state.applyJudgment(makeJudgment('on_task'))
    state.applyJudgment(makeJudgment('on_task'))
    state.applyJudgment(makeJudgment('mild'))
    state.applyJudgment(makeJudgment('on_task'))
    state.applyJudgment(makeJudgment('blatant'))
    const s = useFocusStore.getState()
    expect(s.totalSamples).toBe(5)
    expect(s.onTaskSamples).toBe(3)
  })

  test('snapshotFocusForReport returns null score AND focused_pct when no samples ran', () => {
    // R1 — an AI-off session (or one of pure parse failures) ran no confident
    // samples, so the report must record an UNSCORED session, not the
    // fabricated INITIAL_SCORE.
    const snap = snapshotFocusForReport()
    expect(snap.score).toBeNull()
    expect(snap.focusedPct).toBeNull()
  })

  test('snapshotFocusForReport stays unscored when only uncertain samples ran', () => {
    // R1 + A2 — a session where every tick was a parse failure has
    // totalSamples === 0 (uncertain samples land in skippedSamples), so it
    // must be unscored rather than reporting the untouched INITIAL_SCORE.
    const state = useFocusStore.getState()
    state.applyJudgment(UNCERTAIN)
    state.applyJudgment(UNCERTAIN)
    const s = useFocusStore.getState()
    expect(s.totalSamples).toBe(0)
    expect(s.skippedSamples).toBe(2)
    const snap = snapshotFocusForReport()
    expect(snap.score).toBeNull()
    expect(snap.focusedPct).toBeNull()
  })

  test('snapshotFocusForReport computes focused_pct from the tallies', () => {
    const state = useFocusStore.getState()
    // 4 on_task / 1 mild + 1 mild → 4 / 6 ≈ 0.6667
    state.applyJudgment(makeJudgment('on_task'))
    state.applyJudgment(makeJudgment('on_task'))
    state.applyJudgment(makeJudgment('on_task'))
    state.applyJudgment(makeJudgment('mild'))
    state.applyJudgment(makeJudgment('on_task'))
    state.applyJudgment(makeJudgment('mild'))
    const snap = snapshotFocusForReport()
    expect(snap.score).toBe(useFocusStore.getState().machine.score)
    expect(snap.focusedPct).toBeCloseTo(4 / 6, 5)
  })

  test('A2 — an uncertain verdict is tallied as skipped, not toward focused_pct', () => {
    const state = useFocusStore.getState()
    state.applyJudgment(makeJudgment('on_task'))
    const events = state.applyJudgment(UNCERTAIN)
    expect(events).toEqual([])
    const s = useFocusStore.getState()
    // The uncertain sample is counted only as skipped.
    expect(s.totalSamples).toBe(1)
    expect(s.onTaskSamples).toBe(1)
    expect(s.skippedSamples).toBe(1)
    // focused_pct is over confident samples only: 1/1 = 1.0, not 1/2.
    expect(snapshotFocusForReport().focusedPct).toBeCloseTo(1, 5)
  })

  test('A2 — uncertain does not reset an in-progress off-task streak', () => {
    const state = useFocusStore.getState()
    state.applyJudgment(makeJudgment('mild'))
    expect(useFocusStore.getState().machine.consecutiveOffTask).toBe(1)
    state.applyJudgment(UNCERTAIN)
    // Streak survives the flaky sample.
    expect(useFocusStore.getState().machine.consecutiveOffTask).toBe(1)
    expect(useFocusStore.getState().skippedSamples).toBe(1)
  })

  test('A3 — a shaky off-task verdict (confidence ≥ floor) is treated as skipped', () => {
    __setFocusStoreThresholdReader(() => ({
      warning: DEFAULT_WARNING_THRESHOLD,
      alert: DEFAULT_ALERT_THRESHOLD,
      confidenceFloor: 0.6,
    }))
    const state = useFocusStore.getState()
    const shaky: SampleVerdict = {
      severity: 'moderate',
      reasoning: 'maybe',
      on_topic_confidence: 0.8,
    }
    const events = state.applyJudgment(shaky)
    expect(events).toEqual([])
    const s = useFocusStore.getState()
    expect(s.machine.consecutiveOffTask).toBe(0)
    expect(s.skippedSamples).toBe(1)
    expect(s.totalSamples).toBe(0)
  })

  test('A3 — a confident off-task verdict (confidence < floor) still flags', () => {
    __setFocusStoreThresholdReader(() => ({
      warning: DEFAULT_WARNING_THRESHOLD,
      alert: DEFAULT_ALERT_THRESHOLD,
      confidenceFloor: 0.6,
    }))
    const state = useFocusStore.getState()
    const confident: SampleVerdict = {
      severity: 'mild',
      reasoning: 'distracted',
      on_topic_confidence: 0.2,
    }
    state.applyJudgment(confident)
    const warned = state.applyJudgment(confident)
    expect(warned[0]?.type).toBe('warning')
    expect(useFocusStore.getState().skippedSamples).toBe(0)
    expect(useFocusStore.getState().totalSamples).toBe(2)
  })

  test('reset() clears the skipped tally too', () => {
    const state = useFocusStore.getState()
    state.applyJudgment(UNCERTAIN)
    expect(useFocusStore.getState().skippedSamples).toBe(1)
    state.reset()
    expect(useFocusStore.getState().skippedSamples).toBe(0)
  })
})
