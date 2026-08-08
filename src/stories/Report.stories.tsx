import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, waitFor, within } from 'storybook/test'

import {
  Report,
  ReportView,
  type ResolvedReportData,
} from '@/features/session/Report'
import type { AuditEventRecord } from '@/lib/db/audit'
import type { SessionRecord } from '@/lib/db/sessions'
import { strings } from '@/strings'

const meta = {
  title: 'Feature/Report',
  component: ReportView,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof ReportView>

export default meta
type Story = StoryObj<typeof meta>

// Deterministic clock anchors so the timestamps in the report match across
// renders (Storybook screenshots, snapshots, manual eyeballing).
const STARTED_AT = Date.UTC(2026, 4, 11, 14, 0, 0) // 2026-05-11 14:00:00 UTC
const ENDED_AT = STARTED_AT + 25 * 60_000 // 25-minute Pomodoro

const ME = 'a'.repeat(64)
const ALICE = 'b'.repeat(64)

function event(
  who: string,
  kind: string,
  offsetMs: number,
  detail: Record<string, unknown> = {}
): AuditEventRecord {
  return {
    session_id: 'mock-session',
    ts: STARTED_AT + offsetMs,
    who,
    kind,
    detail: JSON.stringify(detail),
    sig: `${kind}-${who}-${offsetMs}`,
  }
}

function baseSession(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: 'mock-session',
    started_at: STARTED_AT,
    ended_at: ENDED_AT,
    total_minutes: 25,
    peer_pubkeys: JSON.stringify([ALICE]),
    declared_topic: 'Studying',
    score: 100,
    focused_pct: 1,
    generated_at: ENDED_AT,
    confident_samples: null,
    skipped_samples: null,
    ai_enabled: null,
    ...overrides,
  }
}

function buildData(
  session: SessionRecord,
  events: AuditEventRecord[]
): ResolvedReportData {
  return {
    session,
    auditEvents: events,
    nameByEdPubkey: {
      [ME]: 'You',
      [ALICE]: 'Alice',
    },
    myEdPubkeyHex: ME,
  }
}

const onClose = () => {
  // no-op for stories
}

// Mostly-on-task: a clean 25-minute session with one brief mild warning
// halfway through. Focused-time stays high (24/25 ≈ 96%); score drops by
// the warning ticks but no peer-broadcast alert fires.
export const MostlyOnTask: Story = {
  args: {
    data: buildData(
      baseSession({
        score: 96,
        focused_pct: 24 / 25,
        declared_topic: 'Linear algebra problem set',
      }),
      [
        event(ME, 'joined', 0),
        event(ALICE, 'joined', 2_000),
        event(ME, 'pomodoro_start', 30_000, { preset: '25/5' }),
        event(ME, 'ai_warning', 12 * 60_000, {
          severity: 'mild',
          reasoning: 'briefly looked away from the screen',
        }),
        event(ME, 'topic_change', 18 * 60_000, {
          previous_topic: 'Linear algebra problem set',
          new_topic: 'Linear algebra notes review',
        }),
        event(ME, 'pomodoro_end', 25 * 60_000 - 5_000),
        event(ME, 'left', 25 * 60_000),
        event(ALICE, 'left', 25 * 60_000),
      ]
    ),
    animateScore: false,
    onClose,
    showDiagnosticsExport: true,
  },
}

// Settings → Sessions reopens the same report surface, but it must not offer
// today's diagnostics beside an older session. Home is the only production
// caller that opts into the export action.
export const HistoricalReportWithoutDiagnostics: Story = {
  args: {
    ...MostlyOnTask.args,
    showDiagnosticsExport: false,
    closeLabel: strings.settings.sessions.review.backCta,
    autoFocusClose: true,
  },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole('button', {
        name: strings.settings.sessions.review.backCta,
      })
    ).toHaveFocus()
  },
}

const focusTransitionData = buildData(
  baseSession({ declared_topic: 'Focus transition' }),
  []
)
let releaseFocusTransition: (() => void) | null = null

async function loadFocusTransition(): Promise<ResolvedReportData> {
  await new Promise<void>((resolve) => {
    releaseFocusTransition = resolve
  })
  return focusTransitionData
}

export const HistoricalReportPreservesNewerFocus: Story = {
  args: MostlyOnTask.args,
  render: () => (
    <Report
      sessionId={focusTransitionData.session.id}
      onClose={onClose}
      closeLabel={strings.settings.sessions.review.backCta}
      autoFocusClose
      topContent={<button type="button">Pending invite action</button>}
      __loader={loadFocusTransition}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const loadingBack = canvas.getByRole('button', {
      name: strings.settings.sessions.review.backCta,
    })
    await expect(loadingBack).toHaveFocus()

    const newerTarget = canvas.getByRole('button', {
      name: 'Pending invite action',
    })
    newerTarget.focus()
    await expect(newerTarget).toHaveFocus()
    await waitFor(() => expect(releaseFocusTransition).not.toBeNull())
    releaseFocusTransition?.()

    await waitFor(() =>
      expect(
        canvas.getByRole('heading', { name: 'Studied Focus transition' })
      ).toBeInTheDocument()
    )
    await expect(
      canvas.getByRole('button', {
        name: strings.settings.sessions.review.backCta,
      })
    ).not.toHaveFocus()
  },
}

// #47 B3 — the session auto-ended (S1 grace expiry, e.g. a >20s Wi-Fi
// blip), so the header offers Rejoin alongside Close: the room may still be
// live without us.
export const AutoEndedWithRejoin: Story = {
  args: {
    ...MostlyOnTask.args,
    onRejoin: () => {
      // no-op for stories
    },
  },
}

// #47 D5 — a material share of AI checks were unreadable: the summary block
// carries a calm data-quality caveat under the focused-time line.
export const MaterialSkippedChecks: Story = {
  args: {
    ...MostlyOnTask.args,
    data: buildData(
      baseSession({
        score: 88,
        focused_pct: 18 / 20,
        declared_topic: 'Linear algebra problem set',
        confident_samples: 20,
        skipped_samples: 13,
      }),
      [
        event(ME, 'joined', 0),
        event(ALICE, 'joined', 2_000),
        event(ME, 'left', 25 * 60_000),
        event(ALICE, 'left', 25 * 60_000),
      ]
    ),
  },
}

// Mostly-off-task: same 25-minute length but multiple AI alerts fire with
// repeated reasoning ("scrolling social media"). The grouped Top
// distractions section shows the dominant pattern and the cumulative
// score deduction.
export const MostlyOffTask: Story = {
  args: {
    data: buildData(
      baseSession({
        score: 58,
        focused_pct: 9 / 25,
        declared_topic: 'Writing essay draft',
      }),
      [
        event(ME, 'joined', 0),
        event(ALICE, 'joined', 1_000),
        event(ME, 'ai_warning', 3 * 60_000, {
          severity: 'mild',
          reasoning: 'scrolling social media',
        }),
        event(ME, 'ai_alert', 4 * 60_000, {
          severity: 'mild',
          reasoning: 'scrolling social media',
        }),
        event(ME, 'ai_warning', 9 * 60_000, {
          severity: 'moderate',
          reasoning: 'scrolling social media',
        }),
        event(ME, 'ai_alert', 10 * 60_000, {
          severity: 'moderate',
          reasoning: 'scrolling social media',
        }),
        event(ME, 'break_request', 12 * 60_000, {
          requested_duration_sec: 300,
          ai_recommendation: 'approve',
          ai_reasoning: 'first break in 25 minutes',
        }),
        event(ME, 'break_approved', 12 * 60_000 + 200, {
          duration_sec: 300,
          reason: 'approved · 5 min.',
        }),
        event(ME, 'ai_warning', 20 * 60_000, {
          severity: 'blatant',
          reasoning: 'watching a video',
        }),
        event(ME, 'ai_alert', 21 * 60_000, {
          severity: 'blatant',
          reasoning: 'watching a video',
        }),
        event(ME, 'left', 25 * 60_000),
        event(ALICE, 'left', 25 * 60_000),
      ]
    ),
    animateScore: false,
    onClose,
  },
}

// No-AI baseline (R1): lifecycle events only, and a row with no `ai_enabled`
// recorded — i.e. written by a build older than the I83 004 migration. Score
// and focused_pct are null, so the hero renders the calm cause-neutral "No
// focus score" placeholder rather than a fabricated 100/100 gauge. This is the
// one remaining state where the report cannot say WHY nothing was measured.
export const NoAiBaseline: Story = {
  args: {
    data: buildData(
      baseSession({
        score: null,
        focused_pct: null,
        declared_topic: null,
      }),
      [
        event(ME, 'joined', 0),
        event(ALICE, 'joined', 800),
        event(ME, 'pomodoro_start', 5_000, { preset: '25/5' }),
        event(ME, 'pomodoro_end', 25 * 60_000 - 1_000),
        event(ME, 'left', 25 * 60_000),
        event(ALICE, 'left', 25 * 60_000),
      ]
    ),
    animateScore: false,
    onClose,
  },
}

// I83 — AI was ON and produced nothing. This is the state issue #92
// screenshotted from a real Windows session, and the state this PR exists to
// stop rendering as an all-clear: the score card names the malfunction and
// points at Settings → AI, and Top distractions says nothing was measured
// instead of "No distractions detected. Nice work."
export const AiOnButNoChecks: Story = {
  args: {
    data: buildData(
      baseSession({
        score: null,
        focused_pct: null,
        confident_samples: null,
        skipped_samples: null,
        ai_enabled: 1,
        declared_topic: 'latin',
      }),
      [
        event(ME, 'joined', 0),
        event(ME, 'topic_set', 0, { topic: 'latin' }),
        event(ALICE, 'pomodoro_start', 163_000, { preset: '25/5' }),
        event(ME, 'left', 638_000),
      ]
    ),
    animateScore: false,
    onClose,
  },
}

// I83 — AI was deliberately OFF. Nothing was measured and nothing is wrong;
// the copy says so plainly rather than implying a malfunction or claiming a
// clean session the AI never watched.
export const AiOffForSession: Story = {
  args: {
    data: buildData(
      baseSession({
        score: null,
        focused_pct: null,
        confident_samples: null,
        skipped_samples: null,
        ai_enabled: 0,
      }),
      [
        event(ME, 'joined', 0),
        event(ALICE, 'joined', 800),
        event(ME, 'left', 25 * 60_000),
      ]
    ),
    animateScore: false,
    onClose,
  },
}

// I83 — checks ran and none could be read. Two skipped checks is BELOW
// SKIPPED_SAMPLES_MIN (3), so the #47 D5 data-quality line renders nothing and
// this copy is the only thing on the page telling the truth. It must not say
// "No AI checks ran" either: checks did run, none were readable.
export const AiRanNoReadableChecks: Story = {
  args: {
    data: buildData(
      baseSession({
        score: null,
        focused_pct: null,
        confident_samples: 0,
        skipped_samples: 2,
        ai_enabled: 1,
        declared_topic: 'latin',
      }),
      [
        event(ME, 'joined', 0),
        event(ME, 'topic_set', 0, { topic: 'latin' }),
        event(ME, 'left', 638_000),
      ]
    ),
    animateScore: false,
    onClose,
  },
}

// I82 (issue #92) — AI was ON (the topic gate ran, so `topic_set` fired) but
// never managed a single reading, so score and focused_pct are null exactly as
// in AiOnButNoChecks above. The difference is the `ai_stalled` row: the report
// now says WHY the AI section is empty instead of leaving the user to guess
// whether AI was even running. `ai_enabled: 1` is what keeps this the
// "AI was on and broke" case rather than the pre-004 "unknown" one.
export const AiNeverGotAReading: Story = {
  args: {
    data: buildData(
      baseSession({
        score: null,
        focused_pct: null,
        confident_samples: null,
        skipped_samples: null,
        ai_enabled: 1,
        declared_topic: 'latin',
        total_minutes: 10,
        ended_at: STARTED_AT + 10 * 60_000 + 38_000,
      }),
      [
        event(ME, 'joined', 0),
        event(ME, 'topic_set', 0, { topic: 'latin' }),
        event(ALICE, 'joined', 800),
        event(ME, 'ai_stalled', 2 * 60_000 + 5_000, {
          reason: 'inference_timeout',
          reasoning: 'the model took too long to answer',
        }),
        event(ALICE, 'pomodoro_start', 2 * 60_000 + 43_000, {
          preset: '25/5',
        }),
        event(ME, 'left', 10 * 60_000 + 38_000),
      ]
    ),
    animateScore: false,
    onClose,
  },
}

// #187 — the machine fell behind and later caught up. The paired rows prove
// the report no longer leaves an unresolved "couldn't be checked" message.
// Enough surrounding activity is included to overflow the default timeline
// height, exercising the hover-only themed scrollbar and resize separator.
export const AiRecoveredAfterSlowdown: Story = {
  args: {
    data: buildData(
      baseSession({
        score: 92,
        focused_pct: 0.94,
        confident_samples: 18,
        skipped_samples: 1,
        ai_enabled: 1,
        declared_topic: 'statistics revision',
        total_minutes: 25,
      }),
      [
        event(ME, 'joined', 0),
        event(ME, 'topic_set', 200, { topic: 'statistics revision' }),
        event(ALICE, 'joined', 800),
        event(ME, 'pomodoro_start', 15_000, { preset: '25/5' }),
        event(ME, 'ai_warning', 60_000, {
          severity: 'mild',
          reasoning: 'briefly checking an unrelated message',
        }),
        event(ME, 'ai_stalled', 2 * 60_000 + 5_000, {
          reason: 'inference_timeout',
          reasoning: 'the model took too long to answer',
        }),
        event(ALICE, 'paused_break', 2 * 60_000 + 30_000),
        event(ALICE, 'resumed', 3 * 60_000),
        event(ME, 'ai_resumed', 3 * 60_000 + 18_000, {
          reason: 'inference_timeout',
          unavailable_ms: 198_000,
        }),
        event(ME, 'topic_change', 8 * 60_000, {
          previous_topic: 'statistics revision',
          new_topic: 'probability exercises',
        }),
        event(ME, 'break_request', 12 * 60_000, {
          requested_duration_sec: 300,
        }),
        event(ME, 'break_approved', 12 * 60_000 + 3_000, {
          duration_sec: 300,
          reason: 'approved · 5 min.',
        }),
        event(ME, 'resumed', 17 * 60_000 + 3_000),
        event(ME, 'ai_warning', 20 * 60_000, {
          severity: 'mild',
          reasoning: 'looking away from the study material',
        }),
        event(ME, 'pomodoro_end', 25 * 60_000 - 5_000),
        event(ME, 'left', 25 * 60_000),
        event(ALICE, 'left', 25 * 60_000),
      ]
    ),
    animateScore: false,
    onClose,
    showDiagnosticsExport: true,
  },
}
