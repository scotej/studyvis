// V2-P8 — Post-session report.
//
// Splits into two layers:
//   - `Report`     — data-fetching shell. Queries SQLite for the sessions
//                    row + the audit_events table, resolves participant
//                    display names via friendsStore, hands the result to
//                    `ReportView`.
//   - `ReportView` — pure presentational component. Takes already-resolved
//                    data so Storybook can render it without a Tauri
//                    runtime (advisor-flagged separation).
//
// Trigger: Home.tsx routes here when `useSessionStore.status === 'ended'`.
// Settings → Sessions also opens it for a previously-completed session.
//
// All data is read from SQLite — never from in-memory stores — so the
// fresh-session-end render and the re-opened-from-Settings render are
// byte-identical.

import { useEffect, useMemo, useState } from 'react'
import { CheckCircle2Icon, ChevronLeftIcon } from 'lucide-react'

import { ScoreGauge } from '@/components/ScoreGauge'
import { Button } from '@/components/ui/button'
import {
  AUDIT_KIND_LABELS,
  type AuditEventKind,
  isAuditEventKind,
} from '@/lib/audit-types'
import {
  auditEventsListForSession,
  type AuditEventRecord,
} from '@/lib/db/audit'
import { listFriends, type Friend } from '@/lib/db/friends'
import { sessionsGet, type SessionRecord } from '@/lib/db/sessions'
import { useIdentity } from '@/features/identity'
import {
  AUDIT_ICONS,
  AUDIT_ICON_TONE,
  type AuditIconTone,
} from '@/lib/audit-icons'
import { SEVERITY_DEDUCTIONS } from '@/features/ai/scoreMachine'
import type { Severity } from '@/features/ai/parseJudgment'
import {
  deriveTopDistractions,
  deriveTopicTimeline,
  formatOffset,
  groupTimelineByWho,
  parseAuditDetail,
} from './reportData'

export type ReportProps = {
  sessionId: string
  // Optional handler invoked when the user closes the report. The fresh-
  // session-end mount passes `useSessionStore.getState().reset` here so
  // closing the report drops the UI back to the friends list; the Settings
  // → Sessions re-open passes a back-to-list handler instead.
  onClose: () => void
  // Storybook hook so a story can drive the entire data path with mock
  // data and skip the Tauri calls. Production omits it; the shell falls
  // through to the live invocations.
  __loader?: ReportDataLoader
}

export type ReportDataLoader = (
  sessionId: string
) => Promise<ResolvedReportData>

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

type Status =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; data: ResolvedReportData }

// Default loader used in production. Storybook stories override via
// `__loader`. Splitting it out keeps the React component's effect body
// focused on lifecycle, not data plumbing.
async function defaultLoader(sessionId: string): Promise<ResolvedReportData> {
  const [session, auditEvents, friends] = await Promise.all([
    sessionsGet(sessionId),
    auditEventsListForSession(sessionId),
    listFriends(),
  ])
  if (!session) {
    throw new Error('Session not found.')
  }
  const nameByEdPubkey = Object.fromEntries(
    friends
      .filter((f: Friend): f is Friend & { display_name: string } =>
        Boolean(f.display_name && f.display_name.trim().length > 0)
      )
      .map((f) => [f.ed_pubkey_hex, f.display_name])
  )
  return {
    session,
    auditEvents,
    nameByEdPubkey,
    myEdPubkeyHex: null,
  }
}

export function Report({ sessionId, onClose, __loader }: ReportProps) {
  const [status, setStatus] = useState<Status>({ kind: 'loading' })
  const { identity } = useIdentity()
  const myEdPubkeyHex = identity?.ed_pubkey_hex ?? null
  const myDisplayName = identity?.display_name?.trim() || 'You'

  useEffect(() => {
    let cancelled = false
    const loader = __loader ?? defaultLoader
    // eslint-disable-next-line react-hooks/set-state-in-effect -- flips back to loading when sessionId changes (Settings → Sessions opens a different report without unmounting); the .then callback is the productive setState.
    setStatus({ kind: 'loading' })
    loader(sessionId)
      .then((data) => {
        if (cancelled) return
        const merged: ResolvedReportData = {
          ...data,
          // Stitch in self-identity if the loader didn't provide one — the
          // default loader doesn't know the local user, but the Storybook
          // loader can supply it for self-row labeling.
          myEdPubkeyHex: data.myEdPubkeyHex ?? myEdPubkeyHex,
          nameByEdPubkey: {
            ...data.nameByEdPubkey,
            ...(myEdPubkeyHex ? { [myEdPubkeyHex]: myDisplayName } : {}),
          },
        }
        setStatus({ kind: 'ready', data: merged })
      })
      .catch((err: unknown) => {
        if (cancelled) return
        const message =
          err instanceof Error ? err.message : 'Could not load report.'
        setStatus({ kind: 'error', message })
      })
    return () => {
      cancelled = true
    }
  }, [sessionId, __loader, myEdPubkeyHex, myDisplayName])

  if (status.kind === 'loading') {
    return (
      <main
        aria-busy="true"
        role="status"
        className="flex min-h-screen flex-col items-center justify-center bg-bg-base text-text-secondary"
      >
        <span className="sr-only">Loading report…</span>
        <div className="h-3 w-32 animate-pulse rounded-full bg-bg-raised" />
      </main>
    )
  }
  if (status.kind === 'error') {
    return (
      <main
        role="alert"
        className="flex min-h-screen flex-col items-center justify-center gap-4 bg-bg-base text-text-primary"
      >
        <p className="text-text-secondary">{status.message}</p>
        <Button variant="secondary" size="sm" onClick={onClose}>
          <ChevronLeftIcon /> Back
        </Button>
      </main>
    )
  }
  return <ReportView data={status.data} onClose={onClose} />
}

// Pure presentational layer — no side effects, no data fetching. Receives
// the resolved session + audit events + name map and renders the full
// report. Storybook renders this directly with hand-built fixtures.
export type ReportViewProps = {
  data: ResolvedReportData
  onClose: () => void
  // Disables the on-mount ScoreGauge sweep so Storybook snapshots stay
  // deterministic. Production callers pass true (or omit).
  animateScore?: boolean
}

export function ReportView({
  data,
  onClose,
  animateScore = true,
}: ReportViewProps) {
  const { session, auditEvents, nameByEdPubkey, myEdPubkeyHex } = data
  const groupedTimeline = useMemo(
    () => groupTimelineByWho(auditEvents),
    [auditEvents]
  )
  const topDistractions = useMemo(
    () => deriveTopDistractions(auditEvents),
    [auditEvents]
  )
  const topicTimeline = useMemo(
    () => deriveTopicTimeline(session.declared_topic, auditEvents),
    [session.declared_topic, auditEvents]
  )

  const startedAt = session.started_at
  const endedAt = session.ended_at
  const totalMinutes = session.total_minutes ?? 0
  const score = session.score ?? 100
  const focusedPctRaw = session.focused_pct
  const focusedPctLabel =
    focusedPctRaw == null ? '—' : `${Math.round(focusedPctRaw * 100)}%`
  // Compute the timeline anchor once so every row formats its offset
  // against the same reference. Falling back to row.ts per-row (the
  // V2-P8 first-cut behavior) made every row read 00:00 when
  // session.started_at was null — Copilot review on PR #27 caught this.
  // Use sessions.started_at when present; otherwise pick the earliest
  // audit-event ts; default to 0 so formatOffset clamps cleanly.
  const timelineAnchor =
    startedAt ??
    (auditEvents.length > 0 ? Math.min(...auditEvents.map((e) => e.ts)) : 0)

  return (
    <main
      className="flex min-h-screen flex-col bg-bg-base text-text-primary"
      aria-label="Session report"
    >
      <header className="border-b border-border-subtle px-6 py-4">
        <div className="mx-auto flex max-w-4xl items-center justify-between gap-4">
          <div className="flex flex-col">
            <span className="text-xs font-medium tracking-wide text-text-secondary uppercase">
              Session report
            </span>
            <span className="text-sm text-text-secondary">
              {formatHeaderRange(startedAt, endedAt)}
            </span>
          </div>
          <Button variant="secondary" size="sm" onClick={onClose}>
            <ChevronLeftIcon /> Close
          </Button>
        </div>
      </header>

      <div className="mx-auto flex w-full max-w-4xl flex-col gap-8 px-6 py-8">
        <section className="flex flex-col items-center gap-6 sm:flex-row sm:items-stretch sm:justify-between">
          <div className="flex flex-1 flex-col items-center gap-3 text-center sm:items-start sm:text-left">
            <h1 className="text-xl font-semibold tracking-tight">
              {formatTopicHeading(session.declared_topic)}
            </h1>
            <p className="text-sm text-text-secondary">
              Studied for{' '}
              <span className="font-medium text-text-primary">
                {totalMinutes} min
              </span>{' '}
              · Focused-time{' '}
              <span className="font-medium text-text-primary">
                {focusedPctLabel}
              </span>
            </p>
            <p className="text-xs text-text-muted">
              Reports stay on this device. Friends never see your score
              breakdown unless you share it.
            </p>
          </div>
          <ScoreGauge score={score} animate={animateScore} />
        </section>

        <Section heading="Topic">
          {topicTimeline.length === 0 ? (
            <Empty message="No topic recorded." />
          ) : (
            <ol className="m-0 flex list-none flex-col gap-1 p-0">
              {topicTimeline.map((entry, i) => (
                <li
                  key={`${entry.ts}-${entry.topic}-${i}`}
                  className="flex items-center justify-between gap-3 rounded-md border border-border-subtle bg-bg-surface px-3 py-2 text-sm"
                >
                  <span className="text-text-primary">{entry.topic}</span>
                  <span className="text-xs text-text-muted">{entry.label}</span>
                </li>
              ))}
            </ol>
          )}
        </Section>

        <Section heading="Timeline">
          {groupedTimeline.length === 0 ? (
            <Empty message="No events were recorded." />
          ) : (
            <div className="flex flex-col gap-4">
              {groupedTimeline.map(({ who, events }) => (
                <article
                  key={who}
                  className="rounded-lg border border-border-subtle bg-bg-surface"
                >
                  <header className="border-b border-border-subtle px-4 py-2 text-sm font-medium text-text-primary">
                    {labelFor(who, nameByEdPubkey, myEdPubkeyHex)}
                  </header>
                  <ul className="m-0 list-none p-0">
                    {events.map((row) => (
                      <TimelineRow
                        key={row.sig}
                        row={row}
                        anchorTs={timelineAnchor}
                      />
                    ))}
                  </ul>
                </article>
              ))}
            </div>
          )}
        </Section>

        <Section heading="Top distractions">
          {topDistractions.length === 0 ? (
            <Empty message="No distractions detected. Nice work." />
          ) : (
            <ul className="m-0 flex list-none flex-col gap-2 p-0">
              {topDistractions.map((entry, i) => (
                <li
                  key={`${entry.reasoning}-${i}`}
                  className="flex items-start justify-between gap-3 rounded-md border border-border-subtle bg-bg-surface px-3 py-2 text-sm"
                >
                  <span className="text-text-primary">{entry.reasoning}</span>
                  <span className="text-xs font-medium text-text-muted whitespace-nowrap">
                    {entry.count}×
                    {entry.totalDeduction > 0 ? (
                      <> · −{entry.totalDeduction}</>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
    </main>
  )
}

function Section({
  heading,
  children,
}: {
  heading: string
  children: React.ReactNode
}) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-medium tracking-tight text-text-secondary uppercase">
        {heading}
      </h2>
      {children}
    </section>
  )
}

function Empty({ message }: { message: string }) {
  return (
    <p className="rounded-md border border-dashed border-border-subtle bg-bg-surface px-3 py-3 text-sm text-text-muted">
      {message}
    </p>
  )
}

function TimelineRow({
  row,
  anchorTs,
}: {
  row: AuditEventRecord
  anchorTs: number
}) {
  const kind = isAuditEventKind(row.kind) ? row.kind : null
  const Icon = kind ? AUDIT_ICONS[kind] : CheckCircle2Icon
  const tone: AuditIconTone = kind ? AUDIT_ICON_TONE[kind] : 'default'
  const detail = parseAuditDetail(row.detail)
  const reasoning = typeof detail.reasoning === 'string' ? detail.reasoning : ''
  const severity =
    typeof detail.severity === 'string' ? (detail.severity as Severity) : null
  const deduction =
    kind === 'ai_alert' && severity && severity in SEVERITY_DEDUCTIONS
      ? SEVERITY_DEDUCTIONS[severity]
      : null
  const description = describeRow(row, detail)
  return (
    <li
      className="flex items-start gap-3 border-b border-border-subtle px-4 py-2 text-sm last:border-b-0"
      data-testid="report-timeline-row"
    >
      <span
        aria-hidden="true"
        className={`mt-0.5 inline-flex size-6 items-center justify-center rounded-full ${toneClassName(tone)}`}
      >
        <Icon className="size-3.5" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col leading-snug">
        <span className="text-text-primary">{description}</span>
        {reasoning ? (
          <span className="text-xs text-text-secondary">{reasoning}</span>
        ) : null}
      </div>
      <span className="flex shrink-0 items-baseline gap-2 text-xs tabular-nums text-text-muted">
        {deduction != null ? (
          <span className="text-status-alerted">−{deduction}</span>
        ) : null}
        <time dateTime={new Date(row.ts).toISOString()}>
          {formatOffset(row.ts, anchorTs)}
        </time>
      </span>
    </li>
  )
}

function toneClassName(tone: AuditIconTone): string {
  switch (tone) {
    case 'warning':
      return 'bg-status-warning/15 text-status-warning'
    case 'alerted':
      return 'bg-status-alerted/15 text-status-alerted'
    case 'focused':
      return 'bg-status-focused/15 text-status-focused'
    case 'accent':
      return 'bg-accent-default/15 text-accent-default'
    default:
      return 'bg-bg-raised text-text-secondary'
  }
}

function labelFor(
  edPubkeyHex: string,
  nameByEdPubkey: Record<string, string>,
  myEdPubkeyHex: string | null
): string {
  if (myEdPubkeyHex && edPubkeyHex === myEdPubkeyHex) return 'You'
  const friend = nameByEdPubkey[edPubkeyHex]
  if (friend) return friend
  return `Peer ${edPubkeyHex.slice(0, 6)}`
}

function describeRow(
  row: AuditEventRecord,
  detail: Record<string, unknown>
): string {
  const kind = isAuditEventKind(row.kind)
    ? row.kind
    : (row.kind as AuditEventKind)
  const label = AUDIT_KIND_LABELS[kind as AuditEventKind] ?? row.kind
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

function formatTopicHeading(topic: string | null): string {
  if (!topic || !topic.trim()) return 'Studied'
  return `Studied ${topic}`
}

function formatHeaderRange(
  startedAt: number | null,
  endedAt: number | null
): string {
  if (startedAt == null) return 'Session details'
  const start = new Date(startedAt)
  const datePart = start.toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: '2-digit',
  })
  const timePart = start.toLocaleString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  })
  if (endedAt == null) return `${datePart} · ${timePart}`
  const end = new Date(endedAt)
  const endTime = end.toLocaleString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  })
  return `${datePart} · ${timePart} – ${endTime}`
}
