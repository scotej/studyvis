// R7 — Pure data-transform tests for the cross-session focus-insights seam.
// Mirrors stats-data.test.ts / report-data.test.ts: the component renders the
// resolved insights, these tests pin the bucketing / aggregation / trend
// without a DOM.

import { describe, expect, test } from 'vitest'

import type { AuditEventRecord } from '@/lib/db/audit'
import type { SessionRecord } from '@/lib/db/sessions'
import {
  bucketForOffsetMin,
  computeInsights,
  computeRecurringReasons,
  computeTiming,
  computeTrend,
  INSIGHTS_REASON_LIMIT,
} from '@/features/stats/statsInsights'

const START = 1_700_000_000_000

let idc = 0
function session(over: Partial<SessionRecord> = {}): SessionRecord {
  idc += 1
  return {
    id: `s${idc}`,
    started_at: START,
    ended_at: null,
    total_minutes: 30,
    peer_pubkeys: null,
    declared_topic: null,
    score: null,
    focused_pct: null,
    generated_at: null,
    confident_samples: null,
    skipped_samples: null,
    ...over,
  }
}

function evt(
  sessionId: string,
  kind: string,
  offsetMin: number,
  detail: Record<string, unknown> = {}
): AuditEventRecord {
  return {
    session_id: sessionId,
    ts: START + offsetMin * 60_000,
    who: 'a'.repeat(64),
    kind,
    detail: JSON.stringify(detail),
    sig: `${sessionId}-${kind}-${offsetMin}`,
  }
}

describe('bucketForOffsetMin', () => {
  test('early < 15, mid [15,45), late >= 45', () => {
    expect(bucketForOffsetMin(0)).toBe('early')
    expect(bucketForOffsetMin(14)).toBe('early')
    expect(bucketForOffsetMin(15)).toBe('mid')
    expect(bucketForOffsetMin(44)).toBe('mid')
    expect(bucketForOffsetMin(45)).toBe('late')
    expect(bucketForOffsetMin(120)).toBe('late')
  })
})

describe('computeTiming', () => {
  test('buckets distraction events by offset from their own session start', () => {
    const bStart = START + 1_000_000
    const sessions = [
      session({ id: 'A', started_at: START }),
      session({ id: 'B', started_at: bStart }),
    ]
    // B's late event is timestamped 50 min after B's own start, proving the
    // anchor is per-session (not a global START).
    const events = [
      evt('A', 'ai_alert', 2, { reasoning: 'x' }), // early
      evt('A', 'ai_warning', 20, { reasoning: 'y' }), // mid
      {
        session_id: 'B',
        ts: bStart + 50 * 60_000,
        who: 'a'.repeat(64),
        kind: 'ai_alert',
        detail: JSON.stringify({ reasoning: 'z' }),
        sig: 'B-late',
      },
    ]
    const t = computeTiming(sessions, events)
    expect(t).toEqual({ early: 1, mid: 1, late: 1, total: 3 })
  })

  test('non-distraction kinds and empty reasoning are excluded', () => {
    const sessions = [session({ id: 'A', started_at: START })]
    const events = [
      evt('A', 'joined', 1),
      evt('A', 'break_approved', 5, { duration_sec: 300 }),
      evt('A', 'ai_alert', 6, { reasoning: '   ' }), // blank reasoning
    ]
    expect(computeTiming(sessions, events).total).toBe(0)
  })

  test('events for a session with a null start are dropped from timing', () => {
    const sessions = [session({ id: 'A', started_at: null })]
    const events = [evt('A', 'ai_alert', 2, { reasoning: 'x' })]
    expect(computeTiming(sessions, events).total).toBe(0)
  })

  test('an event with no matching session is dropped', () => {
    const events = [evt('ghost', 'ai_alert', 2, { reasoning: 'x' })]
    expect(computeTiming([], events).total).toBe(0)
  })
})

describe('computeRecurringReasons', () => {
  test('tallies identical reasoning across sessions, sorted by count', () => {
    const events = [
      evt('A', 'ai_alert', 2, { reasoning: 'scrolling social media' }),
      evt('B', 'ai_warning', 5, { reasoning: 'scrolling social media' }),
      evt('C', 'ai_alert', 9, { reasoning: 'watching a video' }),
    ]
    expect(computeRecurringReasons(events)).toEqual([
      { reasoning: 'scrolling social media', count: 2 },
      { reasoning: 'watching a video', count: 1 },
    ])
  })

  test('trims reasoning and ignores non-distraction / blank rows', () => {
    const events = [
      evt('A', 'ai_alert', 1, { reasoning: '  on phone  ' }),
      evt('A', 'joined', 2),
      evt('A', 'ai_warning', 3, { reasoning: '' }),
    ]
    expect(computeRecurringReasons(events)).toEqual([
      { reasoning: 'on phone', count: 1 },
    ])
  })

  test('caps the list at INSIGHTS_REASON_LIMIT', () => {
    const events = Array.from({ length: INSIGHTS_REASON_LIMIT + 3 }, (_, i) =>
      evt('A', 'ai_alert', i, { reasoning: `reason ${i}` })
    )
    expect(computeRecurringReasons(events)).toHaveLength(INSIGHTS_REASON_LIMIT)
  })

  test('ties break by reasoning ascending', () => {
    const events = [
      evt('A', 'ai_alert', 1, { reasoning: 'beta' }),
      evt('B', 'ai_alert', 1, { reasoning: 'alpha' }),
    ]
    expect(computeRecurringReasons(events).map((r) => r.reasoning)).toEqual([
      'alpha',
      'beta',
    ])
  })

  test('PR-5: filterWho excludes a peer’s broadcast distraction reasons', () => {
    const mine = {
      ...evt('A', 'ai_alert', 1, { reasoning: 'my phone' }),
      who: 'me',
    }
    const peer1 = {
      ...evt('A', 'ai_alert', 2, { reasoning: 'their youtube' }),
      who: 'peer',
    }
    const peer2 = {
      ...evt('A', 'ai_alert', 3, { reasoning: 'their youtube' }),
      who: 'peer',
    }
    const events = [mine, peer1, peer2]
    expect(computeRecurringReasons(events, 'me')).toEqual([
      { reasoning: 'my phone', count: 1 },
    ])
    // Unfiltered, the peer's reason dominates — the bug this guards.
    expect(computeRecurringReasons(events)[0]).toEqual({
      reasoning: 'their youtube',
      count: 2,
    })
  })
})

describe('computeTrend', () => {
  test('one point per AI-scored session, oldest → newest, focused_pct as whole %', () => {
    const sessions = [
      session({ id: 'late', started_at: 300, focused_pct: 0.9 }),
      session({ id: 'early', started_at: 100, focused_pct: 0.5 }),
      session({ id: 'mid', started_at: 200, focused_pct: 0.755 }),
    ]
    expect(computeTrend(sessions)).toEqual([
      { sessionId: 'early', startedAt: 100, focusedPct: 50 },
      { sessionId: 'mid', startedAt: 200, focusedPct: 76 },
      { sessionId: 'late', startedAt: 300, focusedPct: 90 },
    ])
  })

  test('skips sessions with null focused_pct or null start', () => {
    const sessions = [
      session({ id: 'a', started_at: 100, focused_pct: null }),
      session({ id: 'b', started_at: null, focused_pct: 0.8 }),
      session({ id: 'c', started_at: 200, focused_pct: 0.8 }),
    ]
    expect(computeTrend(sessions).map((p) => p.sessionId)).toEqual(['c'])
  })
})

describe('computeInsights', () => {
  test('hasData is false with no scored sessions and no distractions', () => {
    const insights = computeInsights(
      [session({ focused_pct: null, score: null })],
      []
    )
    expect(insights.hasData).toBe(false)
    expect(insights.timing.total).toBe(0)
    expect(insights.reasons).toEqual([])
    expect(insights.trend).toEqual([])
  })

  test('hasData is true when only a trend exists (scored sessions, no events)', () => {
    const insights = computeInsights(
      [session({ id: 'A', started_at: START, focused_pct: 0.8 })],
      []
    )
    expect(insights.hasData).toBe(true)
    expect(insights.trend).toHaveLength(1)
  })

  test('hasData is true when only distractions exist (no scored sessions)', () => {
    const sessions = [
      session({ id: 'A', started_at: START, focused_pct: null }),
    ]
    const insights = computeInsights(sessions, [
      evt('A', 'ai_alert', 3, { reasoning: 'x' }),
    ])
    expect(insights.hasData).toBe(true)
    expect(insights.timing.total).toBe(1)
    expect(insights.trend).toEqual([])
  })
})
