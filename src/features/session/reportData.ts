// V2-P8 — Pure data transforms used by Report.tsx.
//
// Pulled out of the React component so unit tests can exercise the
// timeline grouping, top-distractions categorization, and topic-timeline
// reconstruction without rendering React. Report.tsx imports these and
// only owns the rendering / data-fetching shell.
//
// All inputs are SQLite-shaped (snake_case) because that's what the
// audit_events_list_for_session / sessions_get commands return; the
// Report consumes the rows verbatim.

import { SEVERITY_DEDUCTIONS } from '@/features/ai/scoreMachine'
import type { Severity } from '@/features/ai/parseJudgment'
import type { AuditEventRecord } from '@/lib/db/audit'

export function parseAuditDetail(raw: string): Record<string, unknown> {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // Malformed JSON detail — fall through to empty map.
  }
  return {}
}

// Groups the audit-event list by `who` (signer ed_pubkey). Within each
// group, events are ts-ascending. Group order matches first-seen-ts so
// the report renders participants in arrival order — consistent with the
// in-session audit panel's chronological feed.
export function groupTimelineByWho(
  events: ReadonlyArray<AuditEventRecord>
): Array<{ who: string; events: AuditEventRecord[] }> {
  const byWho = new Map<string, AuditEventRecord[]>()
  for (const e of events) {
    const list = byWho.get(e.who) ?? []
    list.push(e)
    byWho.set(e.who, list)
  }
  return Array.from(byWho.entries())
    .map(([who, list]) => ({
      who,
      events: [...list].sort((a, b) => a.ts - b.ts),
    }))
    .sort((a, b) => {
      const aFirst = a.events[0]?.ts ?? 0
      const bFirst = b.events[0]?.ts ?? 0
      return aFirst - bFirst
    })
}

export type TopDistraction = {
  reasoning: string
  count: number
  totalDeduction: number
}

// "Top distractions" — categorized AI reasoning text grouped (PLAN.md V2
// success criterion). Groups by exact reasoning string (the model runs
// at temperature 0.0 per ARCHITECTURE.md §8, so duplicate strings are
// common). Combines ai_warning + ai_alert; ai_alert rows additionally
// contribute their deduction (from SEVERITY_DEDUCTIONS) to the group
// total so the user sees how much score the distraction cost. Top 5 by
// count, then by total deduction.
export function deriveTopDistractions(
  events: ReadonlyArray<AuditEventRecord>
): TopDistraction[] {
  const groups = new Map<string, { count: number; totalDeduction: number }>()
  for (const e of events) {
    if (e.kind !== 'ai_warning' && e.kind !== 'ai_alert') continue
    const detail = parseAuditDetail(e.detail)
    const reasoning =
      typeof detail.reasoning === 'string' ? detail.reasoning.trim() : ''
    if (!reasoning) continue
    const existing = groups.get(reasoning) ?? { count: 0, totalDeduction: 0 }
    existing.count += 1
    if (e.kind === 'ai_alert') {
      const severity =
        typeof detail.severity === 'string'
          ? (detail.severity as Severity)
          : null
      if (severity && severity in SEVERITY_DEDUCTIONS) {
        existing.totalDeduction += SEVERITY_DEDUCTIONS[severity]
      }
    }
    groups.set(reasoning, existing)
  }
  return Array.from(groups.entries())
    .map(([reasoning, agg]) => ({ reasoning, ...agg }))
    .sort((a, b) => b.count - a.count || b.totalDeduction - a.totalDeduction)
    .slice(0, 5)
}

export type TopicTimelineEntry = {
  topic: string
  ts: number
  // Display label: "started" for the anchor row, "MM:SS" offset from
  // session-start for each subsequent topic_change. Formatted here so
  // the renderer stays presentation-only.
  label: string
}

// Topic timeline: initial declared topic + every topic_change in order.
// Falls back to "Studying" when neither the sessions row nor an audit
// event recorded a topic — same default the V2-P7 sessionStore uses.
// The walk is by ts; consecutive identical topics collapse (audit-event
// dedup at the wire level is not guaranteed for topic_set, which V2-P9
// will produce).
export function deriveTopicTimeline(
  initialTopic: string | null,
  events: ReadonlyArray<AuditEventRecord>
): TopicTimelineEntry[] {
  const topicEvents = events
    .filter((e) => e.kind === 'topic_change' || e.kind === 'topic_set')
    .sort((a, b) => a.ts - b.ts)
  const anchor =
    initialTopic && initialTopic.trim().length > 0
      ? initialTopic
      : topicEvents[0]
        ? (extractPreviousTopic(topicEvents[0]) ?? 'Studying')
        : 'Studying'
  const startTs = events.length > 0 ? Math.min(...events.map((e) => e.ts)) : 0
  const out: TopicTimelineEntry[] = [
    { topic: anchor, ts: startTs, label: 'started' },
  ]
  for (const e of topicEvents) {
    const detail = parseAuditDetail(e.detail)
    const next =
      typeof detail.new_topic === 'string'
        ? detail.new_topic
        : typeof detail.topic === 'string'
          ? detail.topic
          : null
    if (!next || next === out[out.length - 1].topic) continue
    out.push({
      topic: next,
      ts: e.ts,
      label: formatOffset(e.ts, startTs),
    })
  }
  return out
}

function extractPreviousTopic(event: AuditEventRecord): string | null {
  const detail = parseAuditDetail(event.detail)
  if (typeof detail.previous_topic === 'string') return detail.previous_topic
  if (event.kind === 'topic_set' && typeof detail.topic === 'string') {
    return detail.topic
  }
  return null
}

export function formatOffset(ts: number, anchorTs: number): string {
  const delta = Math.max(0, Math.floor((ts - anchorTs) / 1000))
  const minutes = Math.floor(delta / 60)
  const seconds = delta % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}
