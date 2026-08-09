// V2-P8 — Pure data-transform unit tests for the post-session report.
// Mirrors the test seam pattern used by aiAlerts / scoreMachine: the
// component layer renders the resolved data, these tests pin the
// resolver semantics.

import { describe, expect, test } from 'vitest'

import {
  aiCoverage,
  deriveBreaksSummary,
  deriveTopDistractions,
  deriveTopicTimeline,
  formatOffset,
  groupTimelineByWho,
  parseAuditDetail,
  sampleQualitySummary,
} from '@/features/session/reportData'
import type { AuditEventRecord } from '@/lib/db/audit'

const START_TS = 1_700_000_000_000

function evt(
  who: string,
  kind: string,
  offsetMs: number,
  detail: Record<string, unknown> = {}
): AuditEventRecord {
  return {
    session_id: 'topic-hex',
    ts: START_TS + offsetMs,
    who,
    kind,
    detail: JSON.stringify(detail),
    sig: `${kind}-${who}-${offsetMs}`,
  }
}

describe('parseAuditDetail', () => {
  test('returns the parsed object for valid JSON', () => {
    expect(parseAuditDetail('{"reasoning":"foo"}')).toEqual({
      reasoning: 'foo',
    })
  })
  test('returns empty for malformed JSON', () => {
    expect(parseAuditDetail('not json')).toEqual({})
  })
  test('returns empty for non-object roots', () => {
    expect(parseAuditDetail('[]')).toEqual({})
    expect(parseAuditDetail('null')).toEqual({})
    expect(parseAuditDetail('')).toEqual({})
  })
})

describe('groupTimelineByWho', () => {
  test('groups + sorts events by participant first-seen', () => {
    const events: AuditEventRecord[] = [
      evt('A', 'joined', 0),
      evt('B', 'joined', 1000),
      evt('A', 'left', 3000),
      evt('B', 'ai_warning', 2000, { severity: 'mild', reasoning: 'x' }),
    ]
    const groups = groupTimelineByWho(events)
    expect(groups.map((g) => g.who)).toEqual(['A', 'B'])
    expect(groups[0].events.map((e) => e.kind)).toEqual(['joined', 'left'])
    expect(groups[1].events.map((e) => e.kind)).toEqual([
      'joined',
      'ai_warning',
    ])
  })

  test('group order follows first-seen-ts even with shuffled input', () => {
    // B starts 1s before A, so B's group should sort first.
    const events: AuditEventRecord[] = [
      evt('A', 'joined', 1000),
      evt('B', 'joined', 0),
      evt('A', 'ai_alert', 2000, { severity: 'mild', reasoning: 'x' }),
    ]
    const groups = groupTimelineByWho(events)
    expect(groups.map((g) => g.who)).toEqual(['B', 'A'])
  })

  test('returns empty for empty input', () => {
    expect(groupTimelineByWho([])).toEqual([])
  })
})

describe('deriveTopDistractions', () => {
  test('groups ai_warning + ai_alert by exact reasoning string', () => {
    const events: AuditEventRecord[] = [
      evt('A', 'ai_warning', 0, { severity: 'mild', reasoning: 'scrolling' }),
      evt('A', 'ai_alert', 1000, { severity: 'mild', reasoning: 'scrolling' }),
      evt('A', 'ai_warning', 2000, {
        severity: 'moderate',
        reasoning: 'scrolling',
      }),
      evt('A', 'ai_alert', 3000, {
        severity: 'moderate',
        reasoning: 'scrolling',
      }),
      evt('A', 'ai_warning', 4000, { severity: 'mild', reasoning: 'youtube' }),
    ]
    const distractions = deriveTopDistractions(events)
    expect(distractions).toHaveLength(2)
    expect(distractions[0]).toEqual({
      reasoning: 'scrolling',
      count: 4,
      totalDeduction: 2 + 5, // mild alert + moderate alert
    })
    expect(distractions[1]).toEqual({
      reasoning: 'youtube',
      count: 1,
      totalDeduction: 0,
    })
  })

  test('ignores non-AI events and empty reasoning', () => {
    const events: AuditEventRecord[] = [
      evt('A', 'joined', 0),
      evt('A', 'ai_warning', 1000, { severity: 'mild', reasoning: '' }),
      evt('A', 'ai_alert', 2000, { severity: 'mild', reasoning: '   ' }),
      evt('A', 'left', 3000),
    ]
    expect(deriveTopDistractions(events)).toEqual([])
  })

  test('caps the result at 5 groups', () => {
    const events: AuditEventRecord[] = Array.from({ length: 7 }, (_, i) =>
      evt('A', 'ai_warning', i * 1000, {
        severity: 'mild',
        reasoning: `reason-${i}`,
      })
    )
    expect(deriveTopDistractions(events)).toHaveLength(5)
  })

  test('sorts by count desc, then by totalDeduction desc', () => {
    // r1: count=2, deduction=2 (one alert mild)
    // r2: count=2, deduction=5 (one alert moderate)
    // r3: count=3, deduction=0 (three warnings only)
    const events: AuditEventRecord[] = [
      evt('A', 'ai_warning', 0, { severity: 'mild', reasoning: 'r1' }),
      evt('A', 'ai_alert', 1000, { severity: 'mild', reasoning: 'r1' }),
      evt('A', 'ai_warning', 2000, { severity: 'mild', reasoning: 'r2' }),
      evt('A', 'ai_alert', 3000, { severity: 'moderate', reasoning: 'r2' }),
      evt('A', 'ai_warning', 4000, { severity: 'mild', reasoning: 'r3' }),
      evt('A', 'ai_warning', 5000, { severity: 'mild', reasoning: 'r3' }),
      evt('A', 'ai_warning', 6000, { severity: 'mild', reasoning: 'r3' }),
    ]
    const distractions = deriveTopDistractions(events)
    expect(distractions.map((d) => d.reasoning)).toEqual(['r3', 'r2', 'r1'])
  })

  test('PR-5: filterWho restricts to the local user, excluding peers', () => {
    const events: AuditEventRecord[] = [
      evt('me', 'ai_alert', 0, { severity: 'moderate', reasoning: 'phone' }),
      // A peer's broadcast alerts are persisted locally under the same
      // session but must not count toward the local user's distractions.
      evt('peer', 'ai_alert', 1000, {
        severity: 'blatant',
        reasoning: 'games',
      }),
      evt('peer', 'ai_alert', 2000, {
        severity: 'blatant',
        reasoning: 'games',
      }),
    ]
    const mine = deriveTopDistractions(events, 'me')
    expect(mine.map((d) => d.reasoning)).toEqual(['phone'])
    // Case-insensitive on the ed_pubkey hex.
    expect(deriveTopDistractions(events, 'ME')).toEqual(mine)
    // Omitting the filter keeps the raw all-signers behavior.
    expect(deriveTopDistractions(events).length).toBe(2)
  })

  test('a legacy row with unknown owner never treats every signer as local', () => {
    const events: AuditEventRecord[] = [
      evt('peer', 'ai_warning', 0, {
        severity: 'mild',
        reasoning: 'peer-only warning',
      }),
    ]
    expect(deriveTopDistractions(events, null)).toEqual([])
  })
})

describe('deriveTopicTimeline', () => {
  test('falls back to "Studying" when no topic info exists', () => {
    expect(deriveTopicTimeline(null, [])).toEqual([
      { topic: 'Studying', ts: 0, label: 'started' },
    ])
  })

  test('uses sessions.declared_topic as the anchor when present', () => {
    const events: AuditEventRecord[] = [evt('A', 'joined', 0)]
    const timeline = deriveTopicTimeline('Maths', events)
    expect(timeline).toEqual([
      { topic: 'Maths', ts: START_TS, label: 'started' },
    ])
  })

  test('walks topic_change events and labels them by session-start offset', () => {
    const events: AuditEventRecord[] = [
      evt('A', 'joined', 0),
      evt('A', 'topic_change', 5 * 60_000, {
        previous_topic: 'Maths',
        new_topic: 'Physics',
      }),
      evt('A', 'topic_change', 12 * 60_000, {
        previous_topic: 'Physics',
        new_topic: 'Coding',
      }),
    ]
    const timeline = deriveTopicTimeline('Maths', events)
    expect(timeline.map((e) => e.topic)).toEqual(['Maths', 'Physics', 'Coding'])
    expect(timeline[1].label).toBe('05:00')
    expect(timeline[2].label).toBe('12:00')
  })

  test('collapses consecutive identical topics', () => {
    const events: AuditEventRecord[] = [
      evt('A', 'topic_change', 5 * 60_000, {
        previous_topic: 'Maths',
        new_topic: 'Maths',
      }),
    ]
    expect(deriveTopicTimeline('Maths', events)).toEqual([
      { topic: 'Maths', ts: START_TS + 5 * 60_000, label: 'started' },
    ])
  })

  test('reconstructs the starting topic from the first topic_change.previous_topic when sessions row is null', () => {
    const events: AuditEventRecord[] = [
      evt('A', 'topic_change', 5 * 60_000, {
        previous_topic: 'Reading',
        new_topic: 'Maths',
      }),
    ]
    const timeline = deriveTopicTimeline(null, events)
    expect(timeline.map((e) => e.topic)).toEqual(['Reading', 'Maths'])
  })

  test('honours topic_set with `topic` detail (V2-P9 producer shape)', () => {
    const events: AuditEventRecord[] = [
      evt('A', 'topic_set', 0, { topic: 'Coding' }),
    ]
    const timeline = deriveTopicTimeline(null, events)
    expect(timeline.map((e) => e.topic)).toEqual(['Coding'])
  })

  test('PR-5: filterWho ignores a peer topic_change (no phantom local switch)', () => {
    const events: AuditEventRecord[] = [
      evt('me', 'joined', 0),
      // A peer declares a different topic; broadcast + persisted locally. It
      // must NOT appear as the local user switching topics.
      evt('peer', 'topic_set', 3 * 60_000, { topic: 'Spanish' }),
      evt('me', 'topic_change', 8 * 60_000, {
        previous_topic: 'Calculus',
        new_topic: 'Linear Algebra',
      }),
    ]
    const mine = deriveTopicTimeline('Calculus', events, 'me')
    expect(mine.map((e) => e.topic)).toEqual(['Calculus', 'Linear Algebra'])
    // Without the filter, the peer's topic leaks into the walk.
    expect(deriveTopicTimeline('Calculus', events).map((e) => e.topic)).toEqual(
      ['Calculus', 'Spanish', 'Linear Algebra']
    )
  })

  test('a legacy row with unknown owner excludes signer-specific topic changes', () => {
    const events: AuditEventRecord[] = [
      evt('peer', 'topic_change', 5 * 60_000, {
        previous_topic: 'Calculus',
        new_topic: 'Spanish',
      }),
    ]
    expect(
      deriveTopicTimeline('Calculus', events, null).map((e) => e.topic)
    ).toEqual(['Calculus'])
  })
})

describe('formatOffset', () => {
  test('zero-pads minutes and seconds', () => {
    expect(formatOffset(START_TS, START_TS)).toBe('00:00')
    expect(formatOffset(START_TS + 9_000, START_TS)).toBe('00:09')
    expect(formatOffset(START_TS + 65_000, START_TS)).toBe('01:05')
    expect(formatOffset(START_TS + 60 * 60_000, START_TS)).toBe('60:00')
  })

  test('clamps negative offsets to zero', () => {
    expect(formatOffset(START_TS - 1000, START_TS)).toBe('00:00')
  })
})

describe('deriveBreaksSummary', () => {
  test('returns empty when there are no approved breaks', () => {
    const events: AuditEventRecord[] = [
      evt('A', 'joined', 0),
      evt('A', 'break_request', 1000, { duration_sec: 300 }),
      evt('A', 'break_denied', 2000, { reason: 'too soon' }),
    ]
    expect(deriveBreaksSummary(events)).toEqual([])
  })

  test('sums duration and counts per participant, approved breaks only', () => {
    const events: AuditEventRecord[] = [
      evt('A', 'break_approved', 0, { duration_sec: 300 }),
      evt('A', 'break_approved', 60_000, { duration_sec: 120 }),
      evt('A', 'break_request', 70_000, { duration_sec: 600 }),
      evt('A', 'break_denied', 80_000, {}),
    ]
    expect(deriveBreaksSummary(events)).toEqual([
      { who: 'A', count: 2, totalSec: 420 },
    ])
  })

  test('counts a break with missing/invalid duration as 0 seconds', () => {
    const events: AuditEventRecord[] = [
      evt('A', 'break_approved', 0, {}),
      evt('A', 'break_approved', 1000, { duration_sec: -5 }),
    ]
    expect(deriveBreaksSummary(events)).toEqual([
      { who: 'A', count: 2, totalSec: 0 },
    ])
  })

  test('sorts by total break time, descending', () => {
    const events: AuditEventRecord[] = [
      evt('A', 'break_approved', 0, { duration_sec: 60 }),
      evt('B', 'break_approved', 1000, { duration_sec: 600 }),
    ]
    expect(deriveBreaksSummary(events).map((e) => e.who)).toEqual(['B', 'A'])
  })
})

// #47 D5 — the data-quality line fires only when skips are material.
describe('sampleQualitySummary', () => {
  test('null counts (AI off / pre-003 row) stay silent', () => {
    expect(
      sampleQualitySummary({ confident_samples: null, skipped_samples: null })
    ).toBeNull()
    expect(
      sampleQualitySummary({ confident_samples: 20, skipped_samples: null })
    ).toBeNull()
  })

  test('a couple of skips in a long session stay silent', () => {
    expect(
      sampleQualitySummary({ confident_samples: 50, skipped_samples: 2 })
    ).toBeNull()
    expect(
      sampleQualitySummary({ confident_samples: 96, skipped_samples: 4 })
    ).toBeNull()
  })

  test('a material share of skips surfaces the counts', () => {
    expect(
      sampleQualitySummary({ confident_samples: 30, skipped_samples: 20 })
    ).toEqual({ skipped: 20, totalChecks: 50 })
    expect(
      sampleQualitySummary({ confident_samples: 17, skipped_samples: 3 })
    ).toEqual({ skipped: 3, totalChecks: 20 })
  })

  test('zero checks overall stays silent', () => {
    expect(
      sampleQualitySummary({ confident_samples: 0, skipped_samples: 0 })
    ).toBeNull()
  })
})

// I83 — the report could not tell "AI never ran" from "AI ran and saw nothing".
// Issue #92: a Windows session where AI was on and silently dead rendered
// "No distractions detected. Nice work." beside a card admitting no score was
// recorded. `aiCoverage` is the single derivation both the JSX and the text
// export branch on, so these cases pin the copy for both surfaces at once.
describe('aiCoverage', () => {
  const base = {
    score: null,
    confident_samples: null,
    skipped_samples: null,
    ai_enabled: null,
  }

  test("'ran' when confident samples were recorded", () => {
    expect(aiCoverage({ ...base, confident_samples: 12, ai_enabled: 1 })).toBe(
      'ran'
    )
  })

  test("a zero confident count is not 'ran' just for being non-null", () => {
    // snapshotFocusForReport writes 0 (not NULL) whenever any tick resolved, so
    // non-null-ness alone cannot carry the "was measured" meaning.
    expect(
      aiCoverage({
        ...base,
        confident_samples: 0,
        skipped_samples: 0,
        ai_enabled: 1,
      })
    ).toBe('noChecks')
  })

  // REVERSED during review. The first cut of this returned 'ran' for a session
  // of pure parse failures, arguing the #47 D5 data-quality line caveats it.
  // It does not below SKIPPED_SAMPLES_MIN (3) skips — see the paired test
  // below — so for 1 or 2 unreadable checks the page rendered "Focused-time —",
  // no caveat at all, and "No distractions detected. Nice work.": issue #92's
  // own defect surviving its own fix.
  test("'noConfident' when checks ran but none could be read", () => {
    expect(
      aiCoverage({
        ...base,
        confident_samples: 0,
        skipped_samples: 7,
        ai_enabled: 1,
      })
    ).toBe('noConfident')
  })

  test("'noConfident' in the window the data-quality line does not cover", () => {
    const session = {
      ...base,
      confident_samples: 0,
      skipped_samples: 2,
      ai_enabled: 1,
    }
    expect(aiCoverage(session)).toBe('noConfident')
    // The evidence for the reversal: at 2 skips nothing else on the page says
    // a word about it, so the distractions copy is the only honest surface.
    expect(sampleQualitySummary(session)).toBeNull()
  })

  test("'ran' for a pre-003 row that recorded a score without counters", () => {
    // The 003 migration added the counters, so an older row can hold a real
    // score with NULL counts. That session was measured; don't demote it.
    expect(aiCoverage({ ...base, score: 88 })).toBe('ran')
  })

  test("'noChecks' when AI was on and not one check completed", () => {
    expect(aiCoverage({ ...base, ai_enabled: 1 })).toBe('noChecks')
  })

  test("'off' when AI was recorded as disabled", () => {
    expect(aiCoverage({ ...base, ai_enabled: 0 })).toBe('off')
  })

  test("'unknown' for a row written before the 004 migration", () => {
    // NULL ai_enabled is not 0: claiming "AI was off" for a session nobody
    // recorded the setting for would invent a fact. The cause-neutral R1 copy
    // is the honest render there.
    expect(aiCoverage(base)).toBe('unknown')
  })
})
