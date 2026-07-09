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
// `filterWho` restricts the aggregation to a single signer's events — the
// report passes the LOCAL user's ed_pubkey so peers' broadcast `ai_alert` rows
// (persisted locally under the same session_id) don't inflate the local user's
// distraction list and −deduction total, keeping this consistent with the
// local-only score gauge beside it. Omitted → aggregates every signer (the raw
// transform tests exercise this form).
export function deriveTopDistractions(
  events: ReadonlyArray<AuditEventRecord>,
  filterWho?: string | null
): TopDistraction[] {
  const only =
    filterWho && filterWho.length > 0 ? filterWho.toLowerCase() : null
  const groups = new Map<string, { count: number; totalDeduction: number }>()
  for (const e of events) {
    if (only && e.who.toLowerCase() !== only) continue
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

export type BreakSummaryEntry = {
  who: string
  count: number
  totalSec: number
}

// Per-participant approved-break aggregate for the post-session report.
// Only `break_approved` (the broadcast, friends-visible event) is counted —
// local-only break_request / break_denied are deliberately excluded so the
// report never surfaces a denied request to peers. Sorted by total time, then
// count, descending.
export function deriveBreaksSummary(
  events: ReadonlyArray<AuditEventRecord>
): BreakSummaryEntry[] {
  const byWho = new Map<string, { count: number; totalSec: number }>()
  for (const e of events) {
    if (e.kind !== 'break_approved') continue
    const detail = parseAuditDetail(e.detail)
    const dur =
      typeof detail.duration_sec === 'number' &&
      Number.isFinite(detail.duration_sec)
        ? Math.max(0, detail.duration_sec)
        : 0
    const existing = byWho.get(e.who) ?? { count: 0, totalSec: 0 }
    existing.count += 1
    existing.totalSec += dur
    byWho.set(e.who, existing)
  }
  return Array.from(byWho.entries())
    .map(([who, agg]) => ({ who, ...agg }))
    .sort((a, b) => b.totalSec - a.totalSec || b.count - a.count)
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
// `filterWho` restricts the topic walk to a single signer — the report passes
// the LOCAL user's ed_pubkey so a peer's broadcast `topic_set`/`topic_change`
// (persisted locally) doesn't render as a phantom topic-change in the local
// user's own timeline. The anchor (initialTopic) is already the local declared
// topic and the start offset uses the whole session's first event (shared
// session start), so only the change rows need scoping. Omitted → walks every
// signer's topic events (raw-transform tests).
export function deriveTopicTimeline(
  initialTopic: string | null,
  events: ReadonlyArray<AuditEventRecord>,
  filterWho?: string | null
): TopicTimelineEntry[] {
  const only =
    filterWho && filterWho.length > 0 ? filterWho.toLowerCase() : null
  const topicEvents = events
    .filter((e) => e.kind === 'topic_change' || e.kind === 'topic_set')
    .filter((e) => !only || e.who.toLowerCase() === only)
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
