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

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  BracesIcon,
  CheckCircle2Icon,
  ChevronLeftIcon,
  CopyIcon,
  DownloadIcon,
} from 'lucide-react'
import { toast } from 'sonner'

import { ScoreGauge } from '@/components/ScoreGauge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { tokens } from '@/design/tokens'
import { isAuditEventKind } from '@/lib/audit-types'
import {
  auditEventsListForSession,
  type AuditEventRecord,
} from '@/lib/db/audit'
import {
  fileDateStamp,
  saveTextFile,
  slugify,
  type SaveTextFileResult,
} from '@/lib/fileExport'
import { listFriends, type Friend } from '@/lib/db/friends'
import { sessionsGet } from '@/lib/db/sessions'
import { useIdentity } from '@/features/identity'
import { strings } from '@/strings'
import {
  AUDIT_ICONS,
  AUDIT_ICON_TONE,
  type AuditIconTone,
} from '@/lib/audit-icons'
import { SEVERITY_DEDUCTIONS } from '@/features/ai/scoreMachine'
import type { Severity } from '@/features/ai/parseJudgment'
import { formatBreakDuration } from './break'
import {
  deriveBreaksSummary,
  deriveTopDistractions,
  deriveTopicTimeline,
  formatOffset,
  groupTimelineByWho,
  parseAuditDetail,
} from './reportData'
import {
  describeRow,
  formatTopicHeading,
  labelFor,
  serializeReportToText,
  type ResolvedReportData,
} from './reportSerialize'

export type { ResolvedReportData } from './reportSerialize'

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
    throw new Error(strings.report.notFound)
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
  const [reloadKey, setReloadKey] = useState(0)
  const { identity } = useIdentity()
  const myEdPubkeyHex = identity?.ed_pubkey_hex ?? null
  const myDisplayName =
    identity?.display_name?.trim() || strings.session.selfFallback

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
          err instanceof Error ? err.message : strings.report.loadErrorFallback
        setStatus({ kind: 'error', message })
      })
    return () => {
      cancelled = true
    }
  }, [sessionId, __loader, myEdPubkeyHex, myDisplayName, reloadKey])

  if (status.kind === 'loading' || status.kind === 'error') {
    // §10 — loading + error sit inside the same shell as the loaded view so
    // the user never sees a full-screen sink. Loading shows a Skeleton; the
    // error renders a calm inline banner with a Retry button.
    return (
      <main
        className="flex min-h-full flex-col bg-bg-base text-text-primary"
        aria-label={strings.report.ariaLabel}
      >
        <header className="border-b border-border-subtle px-4 py-4 sm:px-6">
          <div
            className="mx-auto flex items-center justify-between gap-4"
            style={{ maxWidth: tokens.sizes.readingMaxWidth }}
          >
            <div className="flex flex-col">
              <span className="text-xs font-medium tracking-wide text-text-secondary uppercase">
                {strings.report.eyebrow}
              </span>
            </div>
            <Button variant="secondary" size="sm" onClick={onClose}>
              <ChevronLeftIcon /> {strings.common.actions.close}
            </Button>
          </div>
        </header>

        <div
          className="mx-auto flex w-full flex-col gap-8 px-4 py-4 sm:px-6 sm:py-6"
          style={{ maxWidth: tokens.sizes.readingMaxWidth }}
        >
          {status.kind === 'loading' ? (
            <div
              aria-busy="true"
              role="status"
              aria-label={strings.report.loading}
              className="flex flex-col gap-4"
            >
              <span className="sr-only">{strings.report.loading}</span>
              <Skeleton className="h-8 w-2/3" />
              <Skeleton className="h-32 w-full" />
              <Skeleton className="h-20 w-full" />
            </div>
          ) : (
            <div
              role="alert"
              className="flex items-center justify-between gap-4 rounded-md border border-status-alerted/40 bg-status-alerted/10 px-4 py-3 text-sm"
            >
              <span className="text-status-alerted">{status.message}</span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setReloadKey((k) => k + 1)}
              >
                {strings.common.actions.retry}
              </Button>
            </div>
          )}
        </div>
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
    () => deriveTopDistractions(auditEvents, myEdPubkeyHex),
    [auditEvents, myEdPubkeyHex]
  )
  const topicTimeline = useMemo(
    () =>
      deriveTopicTimeline(session.declared_topic, auditEvents, myEdPubkeyHex),
    [session.declared_topic, auditEvents, myEdPubkeyHex]
  )
  const breaksSummary = useMemo(
    () => deriveBreaksSummary(auditEvents),
    [auditEvents]
  )

  const [copied, setCopied] = useState(false)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    return () => {
      if (copyTimer.current) clearTimeout(copyTimer.current)
    }
  }, [])
  const handleCopyReport = async () => {
    try {
      await navigator.clipboard.writeText(serializeReportToText(data))
      setCopied(true)
      if (copyTimer.current) clearTimeout(copyTimer.current)
      copyTimer.current = setTimeout(() => setCopied(false), 1500)
    } catch {
      toast.error(strings.common.errors.copyToClipboard)
    }
  }

  const [exporting, setExporting] = useState(false)
  const exportCopy = strings.report.export

  // The default filename stem ties the file to its session: the topic (or a
  // generic fallback) plus the start date, so a folder of exports stays
  // self-describing.
  const fileStem = `studyvis-${slugify(session.declared_topic ?? 'session')}-${
    session.started_at != null ? fileDateStamp(session.started_at) : 'session'
  }`

  const runExport = async (
    build: () => string,
    options: {
      defaultPath: string
      filterName: string
      extension: string
    },
    savedToast: string
  ) => {
    setExporting(true)
    try {
      const result: SaveTextFileResult = await saveTextFile(build(), {
        defaultPath: options.defaultPath,
        filters: [
          { name: options.filterName, extensions: [options.extension] },
        ],
      })
      if (result.kind === 'saved') toast.success(savedToast)
    } catch {
      toast.error(exportCopy.errorToast)
    } finally {
      setExporting(false)
    }
  }

  const handleSaveReport = () =>
    runExport(
      () => serializeReportToText(data),
      {
        defaultPath: `${fileStem}.md`,
        filterName: exportCopy.reportFilterName,
        extension: 'md',
      },
      exportCopy.savedToast
    )

  const handleSaveAuditLog = () =>
    runExport(
      () => JSON.stringify(auditEvents, null, 2),
      {
        defaultPath: `${fileStem}-audit.json`,
        filterName: exportCopy.auditFilterName,
        extension: 'json',
      },
      exportCopy.auditSavedToast
    )

  const startedAt = session.started_at
  const endedAt = session.ended_at
  const totalMinutes = session.total_minutes ?? 0
  // R1 — a null score means AI focus detection was off (or no confident
  // sample ran). Render the no-score state, never a fabricated 100/100 gauge.
  const score = session.score
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
      className="flex min-h-full flex-col bg-bg-base text-text-primary"
      aria-label={strings.report.ariaLabel}
    >
      <header className="border-b border-border-subtle px-4 py-4 sm:px-6">
        <div
          className="mx-auto flex items-center justify-between gap-4"
          style={{ maxWidth: tokens.sizes.readingMaxWidth }}
        >
          <div className="flex flex-col">
            <span className="text-xs font-medium tracking-wide text-text-secondary uppercase">
              {strings.report.eyebrow}
            </span>
            <span className="text-sm text-text-secondary">
              {formatHeaderRange(startedAt, endedAt)}
            </span>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void handleCopyReport()}
              aria-label={strings.report.copyAriaLabel}
            >
              {copied ? <CheckCircle2Icon /> : <CopyIcon />}{' '}
              {copied ? strings.common.actions.copied : strings.report.copyCta}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void handleSaveReport()}
              disabled={exporting}
              aria-label={exportCopy.saveAriaLabel}
            >
              <DownloadIcon /> {exportCopy.saveCta}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void handleSaveAuditLog()}
              disabled={exporting}
              aria-label={exportCopy.auditAriaLabel}
            >
              <BracesIcon /> {exportCopy.auditCta}
            </Button>
            <Button variant="secondary" size="sm" onClick={onClose}>
              <ChevronLeftIcon /> {strings.common.actions.close}
            </Button>
          </div>
        </div>
      </header>

      <div
        className="mx-auto flex w-full flex-col gap-8 px-4 py-4 sm:px-6 sm:py-6"
        style={{ maxWidth: tokens.sizes.readingMaxWidth }}
      >
        <section className="flex flex-col items-center gap-6 sm:flex-row sm:items-stretch sm:justify-between">
          <div className="flex flex-1 flex-col items-center gap-3 text-center sm:items-start sm:text-left">
            <h1 className="text-xl font-semibold tracking-tight">
              {formatTopicHeading(session.declared_topic)}
            </h1>
            <p className="text-sm text-text-secondary">
              {strings.report.summaryPrefix}
              <span className="font-medium text-text-primary">
                {strings.report.summaryMinutes(totalMinutes)}
              </span>
              {strings.report.summaryMiddle}
              <span className="font-medium text-text-primary">
                {focusedPctLabel}
              </span>
            </p>
            <p className="text-xs text-text-muted">{strings.report.privacy}</p>
          </div>
          {score == null ? (
            <NoScore />
          ) : (
            <ScoreGauge score={score} animate={animateScore} />
          )}
        </section>

        <Section heading={strings.report.sections.topic.heading}>
          {topicTimeline.length === 0 ? (
            <Empty message={strings.report.sections.topic.empty} />
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

        <Section heading={strings.report.sections.timeline.heading}>
          {groupedTimeline.length === 0 ? (
            <Empty message={strings.report.sections.timeline.empty} />
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

        <Section heading={strings.report.sections.distractions.heading}>
          {topDistractions.length === 0 ? (
            <Empty message={strings.report.sections.distractions.empty} />
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

        <Section heading={strings.report.sections.breaks.heading}>
          {breaksSummary.length === 0 ? (
            <Empty message={strings.report.sections.breaks.empty} />
          ) : (
            <ul className="m-0 flex list-none flex-col gap-2 p-0">
              {breaksSummary.map((entry, i) => (
                <li
                  key={`${entry.who}-${i}`}
                  className="flex items-start justify-between gap-3 rounded-md border border-border-subtle bg-bg-surface px-3 py-2 text-sm"
                >
                  <span className="text-text-primary">
                    {labelFor(entry.who, nameByEdPubkey, myEdPubkeyHex)}
                  </span>
                  <span className="text-xs font-medium whitespace-nowrap text-text-muted">
                    {strings.report.sections.breaks.count(entry.count)} ·{' '}
                    {formatBreakDuration(entry.totalSec)}
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

// R1 — calm in-place substitute for the ScoreGauge when a session has no
// recorded focus score (AI off / no confident samples). DESIGN-SYSTEM §10
// empty-state pattern: muted, no spinner, occupies the gauge's footprint so
// the hero layout doesn't reflow.
function NoScore() {
  return (
    <div
      role="img"
      aria-label={strings.report.noScore.heading}
      className="flex flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-border-subtle bg-bg-surface px-6 py-8 text-center"
      style={{
        width: tokens.sizes.scoreGaugeSize,
        height: tokens.sizes.scoreGaugeSize,
      }}
      data-testid="report-no-score"
    >
      <span className="text-sm font-medium text-text-secondary">
        {strings.report.noScore.heading}
      </span>
      <span className="text-xs text-text-muted">
        {strings.report.noScore.body}
      </span>
    </div>
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

function formatHeaderRange(
  startedAt: number | null,
  endedAt: number | null
): string {
  if (startedAt == null) return strings.report.detailsFallback
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
