import type { Meta, StoryObj } from '@storybook/react-vite'

import { ReportView, type ResolvedReportData } from '@/features/session/Report'
import type { AuditEventRecord } from '@/lib/db/audit'
import type { SessionRecord } from '@/lib/db/sessions'

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

// No-AI baseline (R1): lifecycle events only. AI focus detection was off, so
// score AND focused_pct are null — the hero renders the calm "No focus score"
// placeholder instead of a fabricated 100/100 gauge, and the Top distractions
// section shows the "Nice work" empty state.
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
