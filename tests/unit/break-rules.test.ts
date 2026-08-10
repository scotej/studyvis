import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import {
  MAX_BREAKS_PER_SESSION,
  MAX_BREAK_DURATION_SEC,
  MIN_BREAK_DURATION_SEC,
  MIN_BREAK_INTERVAL_MS,
  __resetBreakTimerForTests,
  cancelActiveBreakTimer,
  evaluateBreakRules,
  formatBreakDuration,
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

describe('formatBreakDuration', () => {
  test('renders clean minutes as "N min"', () => {
    expect(formatBreakDuration(300)).toBe('5 min')
    expect(formatBreakDuration(600)).toBe('10 min')
    expect(formatBreakDuration(60)).toBe('1 min')
  })
  test('renders sub-minute durations in seconds', () => {
    expect(formatBreakDuration(30)).toBe('30s')
    expect(formatBreakDuration(59)).toBe('59s')
  })
  test('renders mixed durations as "Nm Ms"', () => {
    expect(formatBreakDuration(90)).toBe('1m 30s')
    expect(formatBreakDuration(125)).toBe('2m 5s')
  })
  test('floors fractional seconds rather than rounding up', () => {
    expect(formatBreakDuration(59.9)).toBe('59s')
  })
})

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

  test('an abort during approval broadcast cannot strand an approved break without a deadline', async () => {
    const controller = new AbortController()
    const liveState = state()
    const deps = buildDeps(liveState)
    let releaseApprovalEmit!: () => void
    let signalApprovalEmitStarted!: () => void
    const approvalEmitStarted = new Promise<void>((resolve) => {
      signalApprovalEmitStarted = resolve
    })
    const approvalEmitCanFinish = new Promise<void>((resolve) => {
      releaseApprovalEmit = resolve
    })

    deps.startApprovedBreak = (args) => {
      startApprovedCalls.push(args)
      liveState.onBreak = true
    }
    deps.endBreak = (endedAt) => {
      endBreakCalls.push(endedAt)
      liveState.onBreak = false
    }
    deps.emitAudit = async (kind, detail) => {
      emitCalls.push({ kind, detail })
      if (kind !== 'break_approved') return
      signalApprovalEmitStarted()
      await approvalEmitCanFinish
    }

    const pending = requestBreak(
      {
        requestedDurationSec: 300,
        aiRecommendation: 'approve',
        aiReasoning: '',
        now: 1_700_000_000_000,
      },
      { ...deps, signal: controller.signal }
    )
    await approvalEmitStarted

    // The state commit and deadline happen before this abortable await.
    expect(liveState.onBreak).toBe(true)
    expect(scheduledTimers).toHaveLength(1)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })

    // Effect-instance aborts can happen while the session stays active. The
    // timer remains the owner of the already-committed break lifecycle.
    scheduledTimers[0]!.handler()
    expect(liveState.onBreak).toBe(false)
    expect(endBreakCalls).toHaveLength(1)

    releaseApprovalEmit()
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

  test('serializes concurrent requests across an awaited audit write', async () => {
    const liveState = state()
    const deps = buildDeps(liveState)
    let releaseFirstAudit!: () => void
    let signalFirstAuditStarted!: () => void
    const firstAuditStarted = new Promise<void>((resolve) => {
      signalFirstAuditStarted = resolve
    })
    const firstAuditCanFinish = new Promise<void>((resolve) => {
      releaseFirstAudit = resolve
    })
    let firstAudit = true
    deps.appendLocalAudit = async (kind, detail) => {
      appendCalls.push({ kind, detail })
      if (!firstAudit) return
      firstAudit = false
      signalFirstAuditStarted()
      await firstAuditCanFinish
    }
    deps.snapshot = () => liveState
    deps.startApprovedBreak = (args) => {
      startApprovedCalls.push(args)
      liveState.onBreak = true
      liveState.breaksThisSession += 1
    }

    const input = {
      requestedDurationSec: 300,
      aiRecommendation: 'approve' as const,
      aiReasoning: '',
      now: 1_700_000_000_000,
    }
    const first = requestBreak(input, deps)
    const second = requestBreak(input, deps)

    await firstAuditStarted
    // The second request is waiting for the first request's full decision,
    // not independently snapshotting the pre-break state.
    expect(appendCalls).toHaveLength(1)
    expect(startApprovedCalls).toHaveLength(0)

    releaseFirstAudit()
    const [firstVerdict, secondVerdict] = await Promise.all([first, second])
    expect(firstVerdict.verdict).toBe('approved')
    expect(secondVerdict.verdict).toBe('denied')
    expect(startApprovedCalls).toHaveLength(1)
    expect(appendCalls).toHaveLength(2)
  })

  test('abandons stale queued work and frees the FIFO while its audit hangs', async () => {
    const staleController = new AbortController()
    let releaseStaleAudit!: () => void
    let signalStaleAuditStarted!: () => void
    let signalStaleAuditFinished!: () => void
    const staleAuditStarted = new Promise<void>((resolve) => {
      signalStaleAuditStarted = resolve
    })
    const staleAuditCanFinish = new Promise<void>((resolve) => {
      releaseStaleAudit = resolve
    })
    const staleAuditFinished = new Promise<void>((resolve) => {
      signalStaleAuditFinished = resolve
    })
    let observedSignal: AbortSignal | undefined
    let staleStartCalls = 0
    let staleEmitCalls = 0
    let queuedAppendCalls = 0

    const staleDeps = buildDeps(state())
    staleDeps.appendLocalAudit = async (_kind, _detail, options) => {
      observedSignal = options?.signal
      signalStaleAuditStarted()
      await staleAuditCanFinish
      // Mirrors SessionView's signal-aware audit path: a sign that finishes
      // after teardown must not append into the next session's audit store.
      if (!options?.signal?.aborted)
        appendCalls.push({ kind: 'late', detail: {} })
      signalStaleAuditFinished()
    }
    staleDeps.startApprovedBreak = () => {
      staleStartCalls += 1
    }
    staleDeps.emitAudit = async () => {
      staleEmitCalls += 1
    }

    const queuedStaleDeps = buildDeps(state())
    queuedStaleDeps.appendLocalAudit = async () => {
      queuedAppendCalls += 1
    }

    const input = {
      requestedDurationSec: 300,
      aiRecommendation: 'approve' as const,
      aiReasoning: '',
      now: 1_700_000_000_000,
    }
    const staleRequest = requestBreak(input, {
      ...staleDeps,
      signal: staleController.signal,
    })
    await staleAuditStarted
    // This request belongs to the same old SessionView but has not acquired
    // the FIFO yet. A teardown must invalidate both it and the in-flight one.
    const queuedStaleRequest = requestBreak(input, {
      ...queuedStaleDeps,
      signal: staleController.signal,
    })

    staleController.abort()
    await expect(staleRequest).rejects.toMatchObject({ name: 'AbortError' })
    await expect(queuedStaleRequest).rejects.toMatchObject({
      name: 'AbortError',
    })

    // Session B can decide immediately even though Session A's signing work
    // has not finished. Before this fix, the module FIFO stayed blocked here.
    let freshStartCalls = 0
    const freshDeps = buildDeps(state())
    freshDeps.startApprovedBreak = () => {
      freshStartCalls += 1
    }
    const freshVerdict = await requestBreak(input, freshDeps)

    expect(freshVerdict.verdict).toBe('approved')
    expect(freshStartCalls).toBe(1)
    expect(observedSignal).toBe(staleController.signal)
    expect(queuedAppendCalls).toBe(0)
    expect(staleStartCalls).toBe(0)
    expect(staleEmitCalls).toBe(0)

    releaseStaleAudit()
    await staleAuditFinished
    expect(appendCalls).toHaveLength(1)
    expect(appendCalls[0]!.kind).toBe('break_request')
  })

  test('a cleared stale timer cannot end a later session or clear its timer', async () => {
    const staleController = new AbortController()
    const input = {
      requestedDurationSec: 300,
      aiRecommendation: 'approve' as const,
      aiReasoning: '',
      now: 1_700_000_000_000,
    }
    const staleDeps = buildDeps(state())
    await requestBreak(input, { ...staleDeps, signal: staleController.signal })
    const staleTimer = scheduledTimers[0]!

    staleController.abort()
    cancelActiveBreakTimer(staleDeps.clearTimeout)

    const freshDeps = buildDeps(state())
    await requestBreak(input, freshDeps)
    expect(scheduledTimers).toHaveLength(1)

    // clearTimeout cannot retract a callback that was already queued. It must
    // not end Session B or erase B's timer record when the old callback runs.
    staleTimer.handler()
    expect(endBreakCalls).toHaveLength(0)

    cancelActiveBreakTimer(freshDeps.clearTimeout)
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
