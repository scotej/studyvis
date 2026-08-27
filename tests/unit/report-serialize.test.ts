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
    ai_enabled: null,
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
  test('renders a recovered unknown duration without fabricating zero minutes', () => {
    const text = serializeReportToText(
      buildData(
        baseSession({ total_minutes: null, total_duration_ms: null }),
        []
      )
    )

    expect(text).toContain(
      `${strings.report.summaryPrefix}${strings.report.summaryUnknownDuration}`
    )
    expect(text).not.toContain(`${strings.report.summaryPrefix}0 min`)
  })

  test('emits Topic → Minute by minute → Timeline → Distractions → Breaks, matching the render', () => {
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
    const written = headingIndex(text, H.written.heading)
    const timeline = headingIndex(text, H.timeline.heading)
    const distractions = headingIndex(text, H.distractions.heading)
    const breaks = headingIndex(text, H.breaks.heading)

    expect(topic).toBeGreaterThanOrEqual(0)
    expect(written).toBeGreaterThan(topic)
    expect(timeline).toBeGreaterThan(written)
    expect(distractions).toBeGreaterThan(timeline)
    expect(breaks).toBeGreaterThan(distractions)
  })

  // #236 — a copied report must carry the written account, and must carry the
  // same honesty label the screen shows when the model did not produce it.
  test('exports the written timeline with its source label', () => {
    const data = buildData(baseSession(), [evt(ME, 'joined', 0)])
    const text = serializeReportToText({
      ...data,
      timeline: {
        session_id: data.session.id,
        generated_at: 1_700_000_400_000,
        model_id: null,
        source: 'observations',
        entries: JSON.stringify([
          { start_min: 0, end_min: 1, summary: 'Opened the assignment' },
          { start_min: 3, end_min: 5, summary: 'Scrolled social media' },
        ]),
        truncated: 1,
      },
    })
    expect(text).toContain('- 0 min — Opened the assignment')
    expect(text).toContain('- 3–5 min — Scrolled social media')
    expect(text).toContain(H.written.sourceNote.observations)
    expect(text).toContain(H.written.truncated)
  })

  test('says nothing was recorded when there is no written timeline', () => {
    const text = serializeReportToText(
      buildData(baseSession(), [evt(ME, 'joined', 0)])
    )
    expect(text).toContain(H.written.empty)
    expect(text).not.toContain(H.written.sourceNote.observations)
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

describe('serializeReportToText — #187 AI recovery', () => {
  test('includes the recovery row after a stalled interval', () => {
    const text = serializeReportToText(
      buildData(baseSession(), [
        evt(ME, 'ai_stalled', 2 * 60_000, {
          reason: 'inference_timeout',
          reasoning: 'the model took too long to answer',
        }),
        evt(ME, 'ai_resumed', 3 * 60_000, {
          reason: 'inference_timeout',
          unavailable_ms: 180_000,
        }),
      ])
    )

    expect(text).toContain("couldn't be checked by AI")
    expect(text).toContain('could be checked by AI again')
  })
})

// I83 — the exported/copied text is an independent second implementation of
// the report's copy, so a fix applied only to the JSX would leave the pasted
// version still claiming a clean session. These pin both halves of the honesty
// change in the surface a user actually shares.
describe('serializeReportToText — AI coverage honesty (I83)', () => {
  const unscored = { score: null, focused_pct: null }

  test('AI on but no checks: names the malfunction, not "Nice work"', () => {
    const text = serializeReportToText(
      buildData(baseSession({ ...unscored, ai_enabled: 1 }), [])
    )
    expect(text).toContain('Score: not recorded (AI ran no checks)')
    expect(text).toContain('No AI checks ran, so nothing was measured here.')
    expect(text).not.toContain('Nice work')
  })

  test('AI off: says so, and still never claims a clean session', () => {
    const text = serializeReportToText(
      buildData(baseSession({ ...unscored, ai_enabled: 0 }), [])
    )
    expect(text).toContain('Score: not recorded (AI off)')
    expect(text).not.toContain('Nice work')
  })

  test('pre-004 row: stays cause-neutral', () => {
    const text = serializeReportToText(
      buildData(baseSession({ ...unscored, ai_enabled: null }), [])
    )
    expect(text).toContain('Score: not recorded')
    expect(text).not.toContain('(AI off)')
    expect(text).not.toContain('(AI ran no checks)')
    expect(text).not.toContain('Nice work')
  })

  test('AI ran and found nothing: the earned praise survives', () => {
    // The whole point of the change is that this case still reads confidently.
    // Note `confident_samples: 30` — the praise is earned by READABLE checks,
    // which is what the noConfident case below establishes.
    const text = serializeReportToText(
      buildData(
        baseSession({
          confident_samples: 30,
          skipped_samples: 0,
          ai_enabled: 1,
        }),
        []
      )
    )
    expect(text).toContain('No distractions detected. Nice work.')
  })

  test('checks ran but none readable: distinct copy, still no praise', () => {
    // Two unreadable checks is below SKIPPED_SAMPLES_MIN, so the #47 D5
    // data-quality line renders nothing and this copy is the only thing that
    // tells the truth. It must not claim "No AI checks ran" either — checks did
    // run; none could be read.
    const text = serializeReportToText(
      buildData(
        baseSession({
          ...unscored,
          confident_samples: 0,
          skipped_samples: 2,
          ai_enabled: 1,
        }),
        []
      )
    )
    expect(text).toContain('Score: not recorded (no readable AI checks)')
    expect(text).toContain(
      'AI checks ran but none could be read, so nothing was measured here.'
    )
    expect(text).not.toContain('Nice work')
    expect(text).not.toContain('No AI checks ran')
  })
})
