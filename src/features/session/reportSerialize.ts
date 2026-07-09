// V2-P8 / R3 / R5 — report text serialization + the participant/row labeling
// helpers shared between the rendered Report and its plain-text export.
//
// Extracted from Report.tsx so the serializer (and the small label helpers it
// shares with the JSX) are pure, React-free, and unit-testable — and so
// Report.tsx satisfies react-refresh's "components-only export" rule. The
// rendered Report imports labelFor / describeRow / formatTopicHeading back for
// its JSX; the "Copy report" / "Save as…" actions and the section-order test
// call serializeReportToText.

import { type AuditEventKind, isAuditEventKind } from '@/lib/audit-types'
import type { AuditEventRecord } from '@/lib/db/audit'
import type { SessionRecord } from '@/lib/db/sessions'
import { strings } from '@/strings'
import { formatBreakDuration } from './break'
import {
  deriveBreaksSummary,
  deriveTopDistractions,
  deriveTopicTimeline,
  formatOffset,
  groupTimelineByWho,
  parseAuditDetail,
} from './reportData'

export type ResolvedReportData = {
  session: SessionRecord
  auditEvents: AuditEventRecord[]
  // ed_pubkey_hex → display name. Local user's own pubkey is also keyed
  // here so the timeline can render "You" for self-emitted rows.
  nameByEdPubkey: Record<string, string>
  // ed_pubkey_hex of the local user. The Report uses it to label self-
  // rows as "You" and to surface "your" score / focused-time copy.
  myEdPubkeyHex: string | null
}

export function labelFor(
  edPubkeyHex: string,
  nameByEdPubkey: Record<string, string>,
  myEdPubkeyHex: string | null
): string {
  if (myEdPubkeyHex && edPubkeyHex === myEdPubkeyHex)
    return strings.session.selfFallback
  const friend = nameByEdPubkey[edPubkeyHex]
  if (friend) return friend
  return strings.session.peerFallback(edPubkeyHex)
}

export function describeRow(
  row: AuditEventRecord,
  detail: Record<string, unknown>
): string {
  const kind = isAuditEventKind(row.kind)
    ? row.kind
    : (row.kind as AuditEventKind)
  const label = strings.audit.kindLabels[kind as AuditEventKind] ?? row.kind
  if (kind === 'topic_change') {
    const previous =
      typeof detail.previous_topic === 'string' ? detail.previous_topic : '?'
    const next = typeof detail.new_topic === 'string' ? detail.new_topic : '?'
    return `topic: ${previous} → ${next}`
  }
  if (kind === 'topic_set' && typeof detail.topic === 'string') {
    return `topic: ${detail.topic}`
  }
  if (kind === 'break_approved' || kind === 'break_denied') {
    const reason = typeof detail.reason === 'string' ? `: ${detail.reason}` : ''
    return `${label}${reason}`
  }
  return label
}

export function formatTopicHeading(topic: string | null): string {
  if (!topic || !topic.trim()) return strings.report.studiedFallback
  return strings.report.studiedWithTopic(topic)
}

// Serializes the report to plain text (light markdown) for the "Copy report"
// and "Save as…" actions — mirrors the on-screen sections so a pasted/saved
// summary matches what the user saw. Local-only; the user pastes or writes it
// wherever they choose. The single source of truth for the export text.
export function serializeReportToText(data: ResolvedReportData): string {
  const { session, auditEvents, nameByEdPubkey, myEdPubkeyHex } = data
  const topicTimeline = deriveTopicTimeline(
    session.declared_topic,
    auditEvents,
    myEdPubkeyHex
  )
  const grouped = groupTimelineByWho(auditEvents)
  const distractions = deriveTopDistractions(auditEvents, myEdPubkeyHex)
  const breaks = deriveBreaksSummary(auditEvents)
  const totalMinutes = session.total_minutes ?? 0
  const focusedPctLabel =
    session.focused_pct == null
      ? '—'
      : `${Math.round(session.focused_pct * 100)}%`
  const anchor =
    session.started_at ??
    (auditEvents.length > 0 ? Math.min(...auditEvents.map((e) => e.ts)) : 0)

  const lines: string[] = [
    formatTopicHeading(session.declared_topic),
    `${strings.report.summaryPrefix}${strings.report.summaryMinutes(totalMinutes)}${strings.report.summaryMiddle}${focusedPctLabel}`,
    // R1 — never emit a fabricated 100 for an unscored (AI-off) session.
    session.score == null
      ? strings.report.noScore.copyLine
      : strings.report.scoreLine(session.score),
    '',
    `## ${strings.report.sections.topic.heading}`,
  ]
  if (topicTimeline.length === 0) {
    lines.push(strings.report.sections.topic.empty)
  } else {
    for (const t of topicTimeline) lines.push(`- ${t.topic} (${t.label})`)
  }

  lines.push('', `## ${strings.report.sections.timeline.heading}`)
  if (grouped.length === 0) {
    lines.push(strings.report.sections.timeline.empty)
  } else {
    for (const g of grouped) {
      lines.push(`### ${labelFor(g.who, nameByEdPubkey, myEdPubkeyHex)}`)
      for (const row of g.events) {
        const detail = parseAuditDetail(row.detail)
        const reasoning =
          typeof detail.reasoning === 'string' && detail.reasoning
            ? ` — ${detail.reasoning}`
            : ''
        lines.push(
          `- ${formatOffset(row.ts, anchor)} ${describeRow(row, detail)}${reasoning}`
        )
      }
    }
  }

  // R5 — section order mirrors the on-screen render (Topic → Timeline →
  // Distractions → Breaks) so a copied/exported summary matches what the
  // user just saw. The on-screen Distractions section precedes Breaks.
  lines.push('', `## ${strings.report.sections.distractions.heading}`)
  if (distractions.length === 0) {
    lines.push(strings.report.sections.distractions.empty)
  } else {
    for (const d of distractions) {
      const ded = d.totalDeduction > 0 ? ` · −${d.totalDeduction}` : ''
      lines.push(`- ${d.reasoning} — ${d.count}×${ded}`)
    }
  }

  lines.push('', `## ${strings.report.sections.breaks.heading}`)
  if (breaks.length === 0) {
    lines.push(strings.report.sections.breaks.empty)
  } else {
    for (const b of breaks) {
      lines.push(
        `- ${labelFor(b.who, nameByEdPubkey, myEdPubkeyHex)}: ${strings.report.sections.breaks.count(b.count)} · ${formatBreakDuration(b.totalSec)}`
      )
    }
  }

  return lines.join('\n')
}
