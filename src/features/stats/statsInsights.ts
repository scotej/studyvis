// R7 — Pure data transforms for the cross-session focus-insights view.
//
// Same seam discipline as statsData.ts / reportData.ts: every computation is
// pure, React-free, Tauri-free, unit-tested. Sources are the local `sessions`
// table (sessions_list) and the full `audit_events` table (audit_events_list_all)
// — both already on the device. Nothing here transmits anywhere.
//
// Three signals, all derived from the AI pipeline's per-streak reasoning that
// today only surfaces in a single post-session report:
//   (a) timing  — when in a session distractions cluster (early/mid/late)
//   (b) reasons — recurring distraction reasoning aggregated across sessions
//   (c) trend   — focused_pct per AI-scored session, oldest → newest
//
// Distraction events reuse the report's exact rule: ai_warning + ai_alert
// rows with a non-empty `reasoning` (see reportData.deriveTopDistractions),
// lifted from one session to all of them.

import type { AuditEventRecord } from '@/lib/db/audit'
import type { SessionRecord } from '@/lib/db/sessions'
import { parseAuditDetail } from '@/features/session/reportData'

export const INSIGHTS_REASON_LIMIT = 6

// Bucket boundaries in minutes from session start. A distraction at exactly
// 15:00 falls in 'mid'; at 45:00 falls in 'late'. Mirrors the report's
// minute-offset framing.
export const EARLY_MAX_MIN = 15
export const MID_MAX_MIN = 45

export type TimingBucket = 'early' | 'mid' | 'late'

export type TimingDistribution = {
  early: number
  mid: number
  late: number
  total: number
}

export type RecurringReason = {
  reasoning: string
  count: number
}

export type TrendPoint = {
  sessionId: string
  startedAt: number
  // Whole-percent focused-time for the session (focused_pct * 100, rounded).
  focusedPct: number
}

export type FocusInsights = {
  // True once at least one AI-scored session OR one distraction event exists —
  // i.e. there is something to show. Drives the §10 empty state.
  hasData: boolean
  timing: TimingDistribution
  reasons: RecurringReason[]
  trend: TrendPoint[]
}

function isDistraction(kind: string): boolean {
  return kind === 'ai_warning' || kind === 'ai_alert'
}

export function bucketForOffsetMin(offsetMin: number): TimingBucket {
  if (offsetMin < EARLY_MAX_MIN) return 'early'
  if (offsetMin < MID_MAX_MIN) return 'mid'
  return 'late'
}

// Builds session-id → started_at so each distraction event can be measured
// against its own session's start. Sessions with a null started_at are
// excluded from the timing distribution (no anchor) but still feed reasons +
// trend, which don't need an offset.
function startedAtBySession(
  sessions: readonly SessionRecord[]
): Map<string, number> {
  const map = new Map<string, number>()
  for (const s of sessions) {
    if (s.started_at != null) map.set(s.id, s.started_at)
  }
  return map
}

// `filterWho` restricts distraction events to a single signer — the Dashboard
// passes the LOCAL user's ed_pubkey so a peer's broadcast `ai_alert` rows
// (persisted locally under the same session_id) aren't tallied into the local
// user's cross-session insights, matching the self-only `computeTrend`. Omitted
// → counts every signer (raw-transform tests).
export function computeTiming(
  sessions: readonly SessionRecord[],
  events: readonly AuditEventRecord[],
  filterWho?: string | null
): TimingDistribution {
  const only =
    filterWho && filterWho.length > 0 ? filterWho.toLowerCase() : null
  const startedAt = startedAtBySession(sessions)
  const dist: TimingDistribution = { early: 0, mid: 0, late: 0, total: 0 }
  for (const e of events) {
    if (only && e.who.toLowerCase() !== only) continue
    if (!isDistraction(e.kind)) continue
    const detail = parseAuditDetail(e.detail)
    const reasoning =
      typeof detail.reasoning === 'string' ? detail.reasoning.trim() : ''
    if (!reasoning) continue
    const anchor = startedAt.get(e.session_id)
    if (anchor == null) continue
    const offsetMin = Math.max(0, Math.floor((e.ts - anchor) / 60_000))
    dist[bucketForOffsetMin(offsetMin)] += 1
    dist.total += 1
  }
  return dist
}

// Recurring distraction reasons across every session. Groups by exact
// reasoning string (the model runs at temperature 0.0, so identical strings
// recur), combining ai_warning + ai_alert — the same grouping the report does
// per-session, here at the multi-session scale. Sorted by count desc, then
// reasoning asc for a stable order; capped at INSIGHTS_REASON_LIMIT.
export function computeRecurringReasons(
  events: readonly AuditEventRecord[],
  filterWho?: string | null
): RecurringReason[] {
  const only =
    filterWho && filterWho.length > 0 ? filterWho.toLowerCase() : null
  const counts = new Map<string, number>()
  for (const e of events) {
    if (only && e.who.toLowerCase() !== only) continue
    if (!isDistraction(e.kind)) continue
    const detail = parseAuditDetail(e.detail)
    const reasoning =
      typeof detail.reasoning === 'string' ? detail.reasoning.trim() : ''
    if (!reasoning) continue
    counts.set(reasoning, (counts.get(reasoning) ?? 0) + 1)
  }
  return Array.from(counts.entries())
    .map(([reasoning, count]) => ({ reasoning, count }))
    .sort((a, b) => b.count - a.count || a.reasoning.localeCompare(b.reasoning))
    .slice(0, INSIGHTS_REASON_LIMIT)
}

// focused_pct trend over time: one point per AI-scored session (focused_pct
// not null), oldest → newest. Sessions without a focused_pct (V1 / AI-off)
// are skipped — they have no focus signal to plot.
export function computeTrend(sessions: readonly SessionRecord[]): TrendPoint[] {
  return sessions
    .filter(
      (s): s is SessionRecord & { started_at: number; focused_pct: number } =>
        s.started_at != null && s.focused_pct != null
    )
    .map((s) => ({
      sessionId: s.id,
      startedAt: s.started_at,
      focusedPct: Math.round(s.focused_pct * 100),
    }))
    .sort(
      (a, b) =>
        a.startedAt - b.startedAt || a.sessionId.localeCompare(b.sessionId)
    )
}

export function computeInsights(
  sessions: readonly SessionRecord[],
  events: readonly AuditEventRecord[],
  filterWho?: string | null
): FocusInsights {
  const timing = computeTiming(sessions, events, filterWho)
  const reasons = computeRecurringReasons(events, filterWho)
  const trend = computeTrend(sessions)
  return {
    hasData: timing.total > 0 || reasons.length > 0 || trend.length > 0,
    timing,
    reasons,
    trend,
  }
}
