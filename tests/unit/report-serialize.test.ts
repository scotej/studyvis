// R5 — section-order regression test for the report serializer.
// serializeReportToText must emit sections in the same order the on-screen
// report renders them (Topic → Timeline → Distractions → Breaks), so a
// copied/saved summary matches what the user just saw. Pure-logic seam:
// no DOM, mirrors tests/unit/report-data.test.ts.

import { describe, expect, test } from 'vitest'

import {
  serializeReportToText,
  type ResolvedReportData,
} from '@/features/session/reportSerialize'
import type { AuditEventRecord } from '@/lib/db/audit'
import type { SessionRecord } from '@/lib/db/sessions'
import { strings } from '@/strings'

const START_TS = 1_700_000_000_000
const ME = 'a'.repeat(64)
const ALICE = 'b'.repeat(64)

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

function baseSession(over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: 'topic-hex',
    started_at: START_TS,
    ended_at: START_TS + 25 * 60_000,
    total_minutes: 25,
    peer_pubkeys: JSON.stringify([ALICE]),
    declared_topic: 'Studying',
    score: 80,
    focused_pct: 0.9,
    generated_at: START_TS + 25 * 60_000,
    confident_samples: null,
    skipped_samples: null,
    ...over,
  }
}

function buildData(
  session: SessionRecord,
  events: AuditEventRecord[]
): ResolvedReportData {
  return {
    session,
    auditEvents: events,
    nameByEdPubkey: { [ME]: 'You', [ALICE]: 'Alice' },
    myEdPubkeyHex: ME,
  }
}

const H = strings.report.sections

function headingIndex(text: string, heading: string): number {
  return text.indexOf(`## ${heading}`)
}

describe('serializeReportToText section order (R5)', () => {
  test('emits Topic → Timeline → Distractions → Breaks, matching the render', () => {
    const text = serializeReportToText(
      buildData(baseSession(), [
        evt(ME, 'joined', 0),
        evt(ALICE, 'joined', 1_000),
        evt(ME, 'ai_alert', 4 * 60_000, {
          severity: 'mild',
          reasoning: 'scrolling social media',
        }),
        evt(ME, 'break_approved', 12 * 60_000, {
          duration_sec: 300,
          reason: 'approved · 5 min.',
        }),
      ])
    )
    const topic = headingIndex(text, H.topic.heading)
    const timeline = headingIndex(text, H.timeline.heading)
    const distractions = headingIndex(text, H.distractions.heading)
    const breaks = headingIndex(text, H.breaks.heading)

    expect(topic).toBeGreaterThanOrEqual(0)
    expect(timeline).toBeGreaterThan(topic)
    expect(distractions).toBeGreaterThan(timeline)
    expect(breaks).toBeGreaterThan(distractions)
  })

  test('section order holds even when both sections are empty', () => {
    const text = serializeReportToText(
      buildData(baseSession(), [evt(ME, 'joined', 0)])
    )
    expect(text).toContain(H.distractions.empty)
    expect(text).toContain(H.breaks.empty)
    expect(headingIndex(text, H.breaks.heading)).toBeGreaterThan(
      headingIndex(text, H.distractions.heading)
    )
  })
})

describe('serializeReportToText score line', () => {
  test('renders the score line for a scored session', () => {
    const text = serializeReportToText(
      buildData(baseSession({ score: 80 }), [])
    )
    expect(text).toContain(strings.report.scoreLine(80))
  })

  test('renders the no-score line for an unscored (AI-off) session', () => {
    const text = serializeReportToText(
      buildData(baseSession({ score: null }), [])
    )
    expect(text).toContain(strings.report.noScore.copyLine)
    expect(text).not.toContain('Score: 100/100')
  })
})
