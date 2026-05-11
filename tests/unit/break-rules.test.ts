import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import {
  MAX_BREAKS_PER_SESSION,
  MAX_BREAK_DURATION_SEC,
  MIN_BREAK_DURATION_SEC,
  MIN_BREAK_INTERVAL_MS,
  __resetBreakTimerForTests,
  cancelActiveBreakTimer,
  evaluateBreakRules,
  requestBreak,
  type BreakAuditPipeline,
  type BreakRuleState,
  type RequestBreakOrchestratorDeps,
} from '@/features/session/break'

function state(overrides: Partial<BreakRuleState> = {}): BreakRuleState {
  return {
    onBreak: false,
    lastBreakEndedAt: null,
    breaksThisSession: 0,
    ...overrides,
  }
}

describe('evaluateBreakRules', () => {
  test('approves a fresh-session 5-min break', () => {
    const verdict = evaluateBreakRules(
      {
        requestedDurationSec: 300,
        aiRecommendation: 'approve',
        aiReasoning: '',
        now: 1_700_000_000_000,
      },
      state()
    )
    expect(verdict.verdict).toBe('approved')
    if (verdict.verdict === 'approved') {
      expect(verdict.durationSec).toBe(300)
      expect(verdict.reason).toContain('5 min')
    }
  })

  test('denies a request shorter than MIN_BREAK_DURATION_SEC', () => {
    const verdict = evaluateBreakRules(
      {
        requestedDurationSec: MIN_BREAK_DURATION_SEC - 1,
        aiRecommendation: 'approve',
        aiReasoning: '',
        now: 1_700_000_000_000,
      },
      state()
    )
    expect(verdict.verdict).toBe('denied')
    if (verdict.verdict === 'denied') {
      expect(verdict.reason).toMatch(/at least/)
    }
  })

  test('clamps a 15-minute request to the 10-minute cap', () => {
    const verdict = evaluateBreakRules(
      {
        requestedDurationSec: 15 * 60,
        aiRecommendation: 'approve',
        aiReasoning: '',
        now: 1_700_000_000_000,
      },
      state()
    )
    expect(verdict.verdict).toBe('approved')
    if (verdict.verdict === 'approved') {
      expect(verdict.durationSec).toBe(MAX_BREAK_DURATION_SEC)
      expect(verdict.reason).toMatch(/capped/)
    }
  })

  test('exact cap (600 s) is approved without the cap note', () => {
    const verdict = evaluateBreakRules(
      {
        requestedDurationSec: MAX_BREAK_DURATION_SEC,
        aiRecommendation: 'approve',
        aiReasoning: '',
        now: 1_700_000_000_000,
      },
      state()
    )
    expect(verdict.verdict).toBe('approved')
    if (verdict.verdict === 'approved') {
      expect(verdict.durationSec).toBe(MAX_BREAK_DURATION_SEC)
      expect(verdict.reason).not.toMatch(/capped/)
    }
  })

  test('denies when already on a break', () => {
    const verdict = evaluateBreakRules(
      {
        requestedDurationSec: 300,
        aiRecommendation: 'approve',
        aiReasoning: '',
        now: 1_700_000_000_000,
      },
      state({ onBreak: true })
    )
    expect(verdict.verdict).toBe('denied')
  })

  test('denies when the per-session quota is exhausted', () => {
    const verdict = evaluateBreakRules(
      {
        requestedDurationSec: 300,
        aiRecommendation: 'approve',
        aiReasoning: '',
        now: 1_700_000_000_000,
      },
      state({ breaksThisSession: MAX_BREAKS_PER_SESSION })
    )
    expect(verdict.verdict).toBe('denied')
    if (verdict.verdict === 'denied') {
      expect(verdict.reason).toMatch(new RegExp(String(MAX_BREAKS_PER_SESSION)))
    }
  })

  test('denies a request 1 ms before the cool-down expires', () => {
    const now = 1_700_000_000_000
    const verdict = evaluateBreakRules(
      {
        requestedDurationSec: 300,
        aiRecommendation: 'approve',
        aiReasoning: '',
        now,
      },
      state({ lastBreakEndedAt: now - MIN_BREAK_INTERVAL_MS + 1 })
    )
    expect(verdict.verdict).toBe('denied')
    if (verdict.verdict === 'denied') {
      expect(verdict.reason).toMatch(/25 minutes/)
    }
  })

  test('approves a request exactly at the cool-down boundary', () => {
    const now = 1_700_000_000_000
    const verdict = evaluateBreakRules(
      {
        requestedDurationSec: 300,
        aiRecommendation: 'approve',
        aiReasoning: '',
        now,
      },
      state({ lastBreakEndedAt: now - MIN_BREAK_INTERVAL_MS })
    )
    expect(verdict.verdict).toBe('approved')
  })

  test('denies when AI recommends deny even if rules pass (advisory tie-breaker)', () => {
    const verdict = evaluateBreakRules(
      {
        requestedDurationSec: 300,
        aiRecommendation: 'deny',
        aiReasoning: 'manipulation attempt',
        now: 1_700_000_000_000,
      },
      state()
    )
    expect(verdict.verdict).toBe('denied')
    if (verdict.verdict === 'denied') {
      expect(verdict.reason).toBe('manipulation attempt')
    }
  })

  test('rule violation overrides an AI approve recommendation', () => {
    // Rule layer is the final arbiter: a clever user can't get the AI to
    // approve when the rules say no. This is the load-bearing security
    // invariant for the rule layer.
    const verdict = evaluateBreakRules(
      {
        requestedDurationSec: 300,
        aiRecommendation: 'approve',
        aiReasoning: 'this is fine',
        now: 1_700_000_000_000,
      },
      state({ breaksThisSession: MAX_BREAKS_PER_SESSION })
    )
    expect(verdict.verdict).toBe('denied')
  })

  test('non-finite duration is denied', () => {
    const verdict = evaluateBreakRules(
      {
        requestedDurationSec: Number.NaN,
        aiRecommendation: 'approve',
        aiReasoning: '',
        now: 1_700_000_000_000,
      },
      state()
    )
    expect(verdict.verdict).toBe('denied')
  })
})

describe('requestBreak orchestrator', () => {
  let appendCalls: Array<{ kind: string; detail: unknown }> = []
  let emitCalls: Array<{ kind: string; detail: unknown }> = []
  let startApprovedCalls: Array<{
    durationSec: number
    startedAt: number
  }> = []
  let endBreakCalls: number[] = []
  let scheduledTimers: Array<{
    handler: () => void
    ms: number
    handle: number
  }> = []

  beforeEach(() => {
    appendCalls = []
    emitCalls = []
    startApprovedCalls = []
    endBreakCalls = []
    scheduledTimers = []
    __resetBreakTimerForTests()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  function buildDeps(
    snapshot: BreakRuleState
  ): RequestBreakOrchestratorDeps & BreakAuditPipeline {
    let nextHandle = 1
    return {
      appendLocalAudit: async (kind, detail) => {
        appendCalls.push({ kind, detail })
      },
      emitAudit: async (kind, detail) => {
        emitCalls.push({ kind, detail })
      },
      startApprovedBreak: (args) => {
        startApprovedCalls.push(args)
      },
      endBreak: (endedAt) => {
        endBreakCalls.push(endedAt)
      },
      setTimeout: (handler, ms) => {
        const handle = nextHandle++
        scheduledTimers.push({ handler, ms, handle })
        return handle
      },
      clearTimeout: (handle) => {
        scheduledTimers = scheduledTimers.filter((t) => t.handle !== handle)
      },
      snapshot: () => snapshot,
      now: () => snapshot.lastBreakEndedAt ?? 1_700_000_000_000,
    }
  }

  test('approve path: emits break_request (local) + break_approved (broadcast) + schedules end', async () => {
    const deps = buildDeps(state())
    const verdict = await requestBreak(
      {
        requestedDurationSec: 300,
        aiRecommendation: 'approve',
        aiReasoning: 'short stretch',
        now: 1_700_000_000_000,
      },
      deps
    )
    expect(verdict.verdict).toBe('approved')
    expect(appendCalls).toHaveLength(1)
    expect(appendCalls[0]!.kind).toBe('break_request')
    expect(emitCalls).toHaveLength(1)
    expect(emitCalls[0]!.kind).toBe('break_approved')
    expect(startApprovedCalls).toEqual([
      { durationSec: 300, startedAt: 1_700_000_000_000 },
    ])
    expect(scheduledTimers).toHaveLength(1)
    expect(scheduledTimers[0]!.ms).toBe(300_000)
  })

  test('approve path: scheduled timer firing calls endBreak with the wall-clock now', async () => {
    const deps = buildDeps(state())
    await requestBreak(
      {
        requestedDurationSec: 300,
        aiRecommendation: 'approve',
        aiReasoning: '',
        now: 1_700_000_000_000,
      },
      deps
    )
    expect(scheduledTimers).toHaveLength(1)
    scheduledTimers[0]!.handler()
    expect(endBreakCalls).toHaveLength(1)
  })

  test('deny path: emits break_request (local) + break_denied (broadcast); no break start, no timer', async () => {
    const deps = buildDeps(state({ breaksThisSession: MAX_BREAKS_PER_SESSION }))
    const verdict = await requestBreak(
      {
        requestedDurationSec: 300,
        aiRecommendation: 'approve',
        aiReasoning: '',
        now: 1_700_000_000_000,
      },
      deps
    )
    expect(verdict.verdict).toBe('denied')
    expect(appendCalls).toHaveLength(1)
    expect(appendCalls[0]!.kind).toBe('break_request')
    expect(emitCalls).toHaveLength(1)
    expect(emitCalls[0]!.kind).toBe('break_denied')
    expect(startApprovedCalls).toHaveLength(0)
    expect(scheduledTimers).toHaveLength(0)
  })

  test('cancelActiveBreakTimer clears the pending end-break timer', async () => {
    const deps = buildDeps(state())
    await requestBreak(
      {
        requestedDurationSec: 300,
        aiRecommendation: 'approve',
        aiReasoning: '',
        now: 1_700_000_000_000,
      },
      deps
    )
    expect(scheduledTimers).toHaveLength(1)
    cancelActiveBreakTimer(deps.clearTimeout)
    expect(scheduledTimers).toHaveLength(0)
  })
})
