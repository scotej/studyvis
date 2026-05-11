// V2-P8 — Pure data-transform unit tests for the post-session report.
// Mirrors the test seam pattern used by aiAlerts / scoreMachine: the
// component layer renders the resolved data, these tests pin the
// resolver semantics.

import { describe, expect, test } from 'vitest'

import {
  deriveTopDistractions,
  deriveTopicTimeline,
  formatOffset,
  groupTimelineByWho,
  parseAuditDetail,
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
    sessionId: 'topic-hex',
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
