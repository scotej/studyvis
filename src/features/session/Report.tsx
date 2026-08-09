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

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from 'react'
import {
  BracesIcon,
  CheckCircle2Icon,
  ChevronLeftIcon,
  CopyIcon,
  DownloadIcon,
  GripHorizontalIcon,
  RotateCcwIcon,
} from 'lucide-react'
import { toast } from 'sonner'

import { ScoreGauge } from '@/components/ScoreGauge'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Skeleton } from '@/components/ui/skeleton'
import { tokens } from '@/design/tokens'
import { isAuditEventKind } from '@/lib/audit-types'
import type { AuditEventRecord } from '@/lib/db/audit'
import {
  fileDateStamp,
  saveTextFile,
  slugify,
  type SaveTextFileResult,
} from '@/lib/fileExport'
import { saveDiagnosticsArchive } from '@/lib/diagnostics'
import { strings } from '@/strings'
import {
  AUDIT_ICONS,
  AUDIT_ICON_TONE,
  type AuditIconTone,
} from '@/lib/audit-icons'
import { SEVERITY_DEDUCTIONS } from '@/features/ai/scoreMachine'
import type { Severity } from '@/features/ai/parseJudgment'
import { formatBreakDuration } from './break'
import { loadReportData } from './reportLoader'
import {
  aiCoverage,
  deriveBreaksSummary,
  deriveTopDistractions,
  deriveTopicTimeline,
  formatOffset,
  groupTimelineByWho,
  sampleQualitySummary,
  parseAuditDetail,
  type AiCoverage,
} from './reportData'
import {
  describeRow,
  distractionsEmptyMessage,
  formatTopicHeading,
  labelFor,
  noScoreBody,
  serializeReportToText,
  type ResolvedReportData,
} from './reportSerialize'

export type { ResolvedReportData } from './reportSerialize'

export type ReportProps = {
  sessionId: string
  // Optional route-global content rendered inside the report's main landmark,
  // after its h1. Home uses this for pending invites so a preceding sibling
  // cannot make this min-h-full surface exceed its bounded app slot.
  topContent?: ReactNode
  // Optional handler invoked when the user closes the report. The fresh-
  // session-end mount passes `useSessionStore.getState().reset` here so
  // closing the report drops the UI back to the friends list; the Settings
  // → Sessions re-open passes a back-to-list handler instead.
  onClose: () => void
  // The caller owns the destination after closing. A historical report uses
  // "Back to sessions" rather than the fresh-session route's generic Close.
  closeLabel?: string
  // Historical reports replace Settings' focused opener. Focus the return
  // action on entry so keyboard and screen-reader users land in the new view.
  autoFocusClose?: boolean
  // #47 B3 / #190 — present when a transport-loss grace period expired or
  // the local user deliberately left while the remote room may still be in
  // its matching 20-second grace period. Rejoining re-enters the same room;
  // the second leave cycle merges into the topic-keyed row
  // (mergeSessionStints in lifecycle.ts), so the report after a rejoin shows
  // accumulated whole-session totals.
  onRejoin?: () => void
  // Absolute deadline captured before teardown begins. The report may spend
  // part of the window loading, so it must not start a fresh 20-second timer.
  rejoinDeadline?: number
  // Issue #161 — only the just-ended Home route opts into this action. A
  // report reopened from Settings must not label today's logs as belonging to
  // an older session.
  showDiagnosticsExport?: boolean
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

function isRejoinAvailable(
  onRejoin: (() => void) | undefined,
  deadline: number | undefined,
  now = Date.now()
): boolean {
  return onRejoin !== undefined && (deadline === undefined || now < deadline)
}

export function Report({
  sessionId,
  topContent,
  onClose,
  closeLabel = strings.common.actions.close,
  autoFocusClose = false,
  onRejoin,
  rejoinDeadline,
  showDiagnosticsExport = false,
  __loader,
}: ReportProps) {
  const [status, setStatus] = useState<Status>({ kind: 'loading' })
  const [reloadKey, setReloadKey] = useState(0)
  const [focusCloseOnMount, setFocusCloseOnMount] = useState(autoFocusClose)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const autoFocusCloseEnabledRef = useRef(autoFocusClose)

  useEffect(() => {
    autoFocusCloseEnabledRef.current = autoFocusClose
  }, [autoFocusClose])

  useEffect(() => {
    let cancelled = false
    const loader = __loader ?? loadReportData
    const preserveCloseFocus = () => {
      // Loading, error, and ready use separate report trees. Carry focus to
      // the replacement Back/Close button only while that button still owns
      // focus; an async load must not override newer keyboard intent.
      setFocusCloseOnMount(
        autoFocusCloseEnabledRef.current &&
          document.activeElement === closeButtonRef.current
      )
    }
    preserveCloseFocus()
    // eslint-disable-next-line react-hooks/set-state-in-effect -- flips back to loading when sessionId changes (Settings → Sessions opens a different report without unmounting); the .then callback is the productive setState.
    setStatus({ kind: 'loading' })
    loader(sessionId)
      .then((data) => {
        if (cancelled) return
        preserveCloseFocus()
        setStatus({ kind: 'ready', data })
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
  }, [sessionId, __loader, reloadKey])

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
              <h1 className="text-xs font-medium tracking-wide text-text-secondary uppercase">
                {strings.report.eyebrow}
              </h1>
            </div>
            <Button
              ref={closeButtonRef}
              variant="secondary"
              size="sm"
              onClick={onClose}
              autoFocus={focusCloseOnMount}
            >
              <ChevronLeftIcon /> {closeLabel}
            </Button>
          </div>
        </header>

        {topContent}

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

  return (
    <ReportView
      data={status.data}
      onClose={onClose}
      closeLabel={closeLabel}
      autoFocusClose={focusCloseOnMount}
      closeButtonRef={closeButtonRef}
      onRejoin={onRejoin}
      rejoinDeadline={rejoinDeadline}
      showDiagnosticsExport={showDiagnosticsExport}
      topContent={topContent}
    />
  )
}

// Pure presentational layer — no side effects, no data fetching. Receives
// the resolved session + audit events + name map and renders the full
// report. Storybook renders this directly with hand-built fixtures.
export type ReportViewProps = {
  data: ResolvedReportData
  onClose: () => void
  closeLabel?: string
  autoFocusClose?: boolean
  // Report's async shell uses this to preserve focus across its loading and
  // ready trees without overriding a user's newer focus target.
  closeButtonRef?: Ref<HTMLButtonElement>
  topContent?: ReactNode
  // #47 B3 — see ReportProps.onRejoin.
  onRejoin?: () => void
  rejoinDeadline?: number
  // See ReportProps.showDiagnosticsExport.
  showDiagnosticsExport?: boolean
  // Disables the on-mount ScoreGauge sweep so Storybook snapshots stay
  // deterministic. Production callers pass true (or omit).
  animateScore?: boolean
}

export function ReportView({
  data,
  onClose,
  closeLabel = strings.common.actions.close,
  autoFocusClose = false,
  closeButtonRef,
  topContent,
  onRejoin,
  rejoinDeadline,
  showDiagnosticsExport = false,
  animateScore = true,
}: ReportViewProps) {
  const { session, auditEvents, nameByEdPubkey, myEdPubkeyHex } = data
  const timelineHeadingId = useId()
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
  // #47 D5 — non-null only when a material share of AI checks were skipped.
  const sampleQuality = sampleQualitySummary(session)
  // I83 — whether the AI measured anything, and if not, whether we know why.
  // Drives the score card's body copy and the distractions empty state, which
  // must agree: one claiming "no score recorded" beside the other saying "Nice
  // work" is the contradiction issue #92 screenshotted.
  const coverage = aiCoverage(session)

  const [expiredDeadline, setExpiredDeadline] = useState<number | null>(null)
  const rejoinAvailable =
    isRejoinAvailable(onRejoin, rejoinDeadline) &&
    expiredDeadline !== rejoinDeadline
  useEffect(() => {
    if (!isRejoinAvailable(onRejoin, rejoinDeadline)) return
    if (rejoinDeadline === undefined) return
    const handle = setTimeout(
      () => setExpiredDeadline(rejoinDeadline),
      Math.max(0, rejoinDeadline - Date.now())
    )
    return () => clearTimeout(handle)
  }, [onRejoin, rejoinDeadline])

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

  const [exportingDiagnostics, setExportingDiagnostics] = useState(false)
  const diagnosticsExportingRef = useRef(false)
  const handleDownloadDiagnostics = async () => {
    if (diagnosticsExportingRef.current) return
    diagnosticsExportingRef.current = true
    setExportingDiagnostics(true)
    try {
      const result = await saveDiagnosticsArchive({
        defaultPath: `${fileStem}-diagnostics.zip`,
        sessionPrefix: session.id.slice(0, 8),
      })
      if (result.kind === 'saved') {
        toast.success(strings.diagnostics.savedToast)
      }
    } catch {
      toast.error(strings.diagnostics.errorToast)
    } finally {
      diagnosticsExportingRef.current = false
      setExportingDiagnostics(false)
    }
  }

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
            {showDiagnosticsExport ? (
              <Button
                variant="default"
                size="sm"
                onClick={() => void handleDownloadDiagnostics()}
                disabled={exportingDiagnostics}
                aria-busy={exportingDiagnostics}
                aria-label={strings.diagnostics.downloadAriaLabel}
              >
                <DownloadIcon />
                {exportingDiagnostics
                  ? strings.diagnostics.preparingCta
                  : strings.diagnostics.downloadCta}
              </Button>
            ) : null}
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
            {onRejoin ? (
              <Button
                variant="default"
                size="sm"
                onClick={onRejoin}
                disabled={!rejoinAvailable}
              >
                <RotateCcwIcon /> {strings.report.rejoinCta}
              </Button>
            ) : null}
            <Button
              ref={closeButtonRef}
              variant="secondary"
              size="sm"
              onClick={onClose}
              autoFocus={autoFocusClose}
            >
              <ChevronLeftIcon /> {closeLabel}
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
            {sampleQuality ? (
              <p className="text-xs text-text-muted">
                {strings.report.dataQuality(
                  sampleQuality.skipped,
                  sampleQuality.totalChecks
                )}
              </p>
            ) : null}
            <p className="text-xs text-text-muted">{strings.report.privacy}</p>
            {myEdPubkeyHex === null ? (
              <p className="text-xs text-text-muted">
                {strings.report.identityUnavailable}
              </p>
            ) : null}
          </div>
          {score == null ? (
            <NoScore coverage={coverage} />
          ) : (
            <ScoreGauge score={score} animate={animateScore} />
          )}
        </section>

        {topContent}

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

        <Section
          heading={strings.report.sections.timeline.heading}
          headingId={timelineHeadingId}
        >
          {groupedTimeline.length === 0 ? (
            <Empty message={strings.report.sections.timeline.empty} />
          ) : (
            <ResizableTimeline
              groups={groupedTimeline}
              headingId={timelineHeadingId}
              nameByEdPubkey={nameByEdPubkey}
              myEdPubkeyHex={myEdPubkeyHex}
              anchorTs={timelineAnchor}
            />
          )}
        </Section>

        <Section heading={strings.report.sections.distractions.heading}>
          {topDistractions.length === 0 ? (
            <Empty
              message={
                myEdPubkeyHex === null
                  ? strings.report.identityUnavailable
                  : distractionsEmptyMessage(coverage)
              }
            />
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
  headingId,
  children,
}: {
  heading: string
  headingId?: string
  children: React.ReactNode
}) {
  return (
    <section className="flex flex-col gap-3">
      <h2
        id={headingId}
        className="text-sm font-medium tracking-wide text-text-secondary uppercase"
      >
        {heading}
      </h2>
      {children}
    </section>
  )
}

type TimelineGroup = ReturnType<typeof groupTimelineByWho>[number]

function clampTimelineHeight(height: number): number {
  return Math.min(
    tokens.sizes.reportTimelineMaxHeight,
    Math.max(tokens.sizes.reportTimelineMinHeight, height)
  )
}

function ResizableTimeline({
  groups,
  headingId,
  nameByEdPubkey,
  myEdPubkeyHex,
  anchorTs,
}: {
  groups: TimelineGroup[]
  headingId: string
  nameByEdPubkey: Record<string, string>
  myEdPubkeyHex: string | null
  anchorTs: number
}) {
  const timelineId = useId()
  const [height, setHeight] = useState(tokens.sizes.reportTimelineDefaultHeight)
  const stopResizeRef = useRef<(() => void) | null>(null)

  useEffect(() => () => stopResizeRef.current?.(), [])

  const beginResize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    stopResizeRef.current?.()
    const startY = event.clientY
    const startHeight = height
    const onMove = (moveEvent: PointerEvent) => {
      setHeight(clampTimelineHeight(startHeight + moveEvent.clientY - startY))
    }
    const stop = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', stop)
      window.removeEventListener('pointercancel', stop)
      stopResizeRef.current = null
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', stop)
    window.addEventListener('pointercancel', stop)
    stopResizeRef.current = stop
  }

  return (
    <div className="relative">
      <ScrollArea
        id={timelineId}
        type="hover"
        scrollHideDelay={tokens.motion.duration.slow}
        role="region"
        aria-labelledby={headingId}
        className="overflow-hidden rounded-lg border border-border-subtle bg-bg-surface"
        viewportClassName="bg-bg-base p-1 pr-3"
        scrollbarClassName="w-2 bg-bg-surface/80 [&_[data-slot=scroll-area-thumb]]:bg-border-strong"
        style={{ height }}
      >
        <div className="flex flex-col gap-4">
          {groups.map(({ who, events }) => (
            <article
              key={who}
              className="rounded-lg border border-border-subtle bg-bg-surface"
            >
              <header className="border-b border-border-subtle px-4 py-2 text-sm font-medium text-text-primary">
                {labelFor(who, nameByEdPubkey, myEdPubkeyHex)}
              </header>
              <ul className="m-0 list-none p-0">
                {events.map((row) => (
                  <TimelineRow key={row.sig} row={row} anchorTs={anchorTs} />
                ))}
              </ul>
            </article>
          ))}
        </div>
      </ScrollArea>
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-controls={timelineId}
        aria-label={strings.report.timelineResizeAriaLabel}
        aria-valuemin={tokens.sizes.reportTimelineMinHeight}
        aria-valuemax={tokens.sizes.reportTimelineMaxHeight}
        aria-valuenow={height}
        tabIndex={0}
        onPointerDown={beginResize}
        onKeyDown={(event) => {
          if (
            event.key !== 'ArrowUp' &&
            event.key !== 'ArrowDown' &&
            event.key !== 'Home' &&
            event.key !== 'End'
          ) {
            return
          }
          event.preventDefault()
          if (event.key === 'Home') {
            setHeight(tokens.sizes.reportTimelineMinHeight)
            return
          }
          if (event.key === 'End') {
            setHeight(tokens.sizes.reportTimelineMaxHeight)
            return
          }
          setHeight((current) =>
            clampTimelineHeight(
              current +
                (event.key === 'ArrowDown' ? tokens.space[5] : -tokens.space[5])
            )
          )
        }}
        className="absolute -bottom-2 left-0 z-10 flex h-4 w-full touch-none cursor-row-resize items-center justify-center rounded outline-none focus-visible:ring-3 focus-visible:ring-accent-ring"
      >
        <GripHorizontalIcon className="size-4 rounded bg-bg-base text-text-muted" />
      </div>
    </div>
  )
}

function Empty({ message }: { message: string }) {
  return (
    <p className="rounded-md border border-dashed border-border-subtle bg-bg-surface px-3 py-3 text-sm text-text-secondary">
      {message}
    </p>
  )
}

// R1 — calm in-place substitute for the ScoreGauge when a session has no
// recorded focus score (AI off / no confident samples). DESIGN-SYSTEM §10
// empty-state pattern: muted, no spinner, occupies the gauge's footprint so
// the hero layout doesn't reflow.
//
// I83 — the body names the cause when the row recorded one; `noScoreBody` lives
// in reportSerialize.ts so the exported copy is shared with the text export and
// this file keeps only component exports (react-refresh).
function NoScore({ coverage }: { coverage: AiCoverage }) {
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
      <span className="text-xs text-text-muted">{noScoreBody(coverage)}</span>
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
