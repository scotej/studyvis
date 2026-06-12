import type { Meta, StoryObj } from '@storybook/react-vite'

import { computeInsights, computeStats, DashboardView } from '@/features/stats'
import type { AuditEventRecord } from '@/lib/db/audit'
import type { Friend } from '@/lib/db/friends'
import type { SessionRecord } from '@/lib/db/sessions'

// Render the pure view directly with synthetic data, the same pattern as
// Report.stories.tsx. The decorator reproduces the exact width the Stats
// category renders at in production (Settings pane, max-w-2xl) so the
// 30-bar chart is visually verified under the real constraint.
const meta = {
  title: 'Features/Stats/Dashboard',
  component: DashboardView,
  parameters: { layout: 'padded' },
  decorators: [
    (Story) => (
      <div className="mx-auto w-full max-w-2xl rounded-lg border border-border-subtle bg-bg-base px-8 py-8">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof DashboardView>

export default meta
type Story = StoryObj<typeof meta>

const DAY = 86_400_000
const NOW = Date.UTC(2026, 4, 18, 12, 0, 0) // 2026-05-18T12:00:00Z
const ALICE = 'a'.repeat(64)
const BO = 'b'.repeat(64)

let n = 0
function session(over: Partial<SessionRecord> = {}): SessionRecord {
  n += 1
  return {
    id: `story-${n}`,
    started_at: NOW,
    ended_at: null,
    total_minutes: 30,
    peer_pubkeys: null,
    declared_topic: null,
    score: null,
    focused_pct: null,
    generated_at: null,
    ...over,
  }
}

const friends: Friend[] = [
  {
    ed_pubkey_hex: ALICE,
    x_pubkey_hex: 'x-a',
    display_name: 'Alice',
    paired_at: 1,
    last_studied_with: null,
  },
  {
    ed_pubkey_hex: BO,
    x_pubkey_hex: 'x-b',
    display_name: 'Bo',
    paired_at: 1,
    last_studied_with: null,
  },
]

function distraction(
  sessionId: string,
  sessionStart: number,
  offsetMin: number,
  reasoning: string,
  kind: 'ai_warning' | 'ai_alert' = 'ai_alert'
): AuditEventRecord {
  return {
    session_id: sessionId,
    ts: sessionStart + offsetMin * 60_000,
    who: ALICE,
    kind,
    detail: JSON.stringify({ severity: 'moderate', reasoning }),
    sig: `${sessionId}-${kind}-${offsetMin}`,
  }
}

// 0 sessions — the calm empty state (DESIGN-SYSTEM.md §10).
export const Empty: Story = {
  args: {
    summary: computeStats([], [], NOW, 'UTC'),
    insights: computeInsights([], []),
  },
}

// 1 session — a single bar, a one-day streak, one partner, one score. AI ran
// but logged no distractions, so the focus-insights section shows its own
// empty state.
export const SingleSession: Story = {
  args: {
    summary: computeStats(
      [
        session({
          total_minutes: 25,
          started_at: NOW,
          score: 88,
          peer_pubkeys: JSON.stringify([ALICE]),
        }),
      ],
      friends,
      NOW,
      'UTC'
    ),
    insights: computeInsights([], []),
  },
}

// 30+ sessions — a busy month: a session most days (some days double),
// alternating partners, ~70% scored. Verifies the full chart + axis
// thinning at the production width, plus the populated focus-insights
// section (timing buckets, recurring reasons, focus trend line).
const busyMonthSessions = Array.from({ length: 38 }, (_, i) => {
  const daysBack = Math.floor(i / 1.4) // some days get two sessions
  const startedAt = NOW - daysBack * DAY
  const focused = i % 3 === 0 ? null : 0.6 + ((i * 5) % 30) / 100
  return session({
    id: `month-${i}`,
    total_minutes: 20 + ((i * 7) % 45),
    started_at: startedAt,
    score: i % 3 === 0 ? null : 70 + ((i * 5) % 30),
    focused_pct: focused,
    peer_pubkeys: JSON.stringify([i % 2 === 0 ? ALICE : BO]),
  })
})

const busyMonthAudit: AuditEventRecord[] = busyMonthSessions.flatMap((s, i) =>
  s.started_at == null
    ? []
    : [
        distraction(s.id, s.started_at, 5, 'scrolling social media'),
        ...(i % 2 === 0
          ? [distraction(s.id, s.started_at, 30, 'watching a video')]
          : []),
        ...(i % 5 === 0
          ? [distraction(s.id, s.started_at, 50, 'phone notifications')]
          : []),
      ]
)

export const PopulatedMonth: Story = {
  args: {
    summary: computeStats(busyMonthSessions, friends, NOW, 'UTC'),
    insights: computeInsights(busyMonthSessions, busyMonthAudit),
  },
}

// R6 — most sessions are unscored: "Average" over 2 of 40 sessions. The
// score tile surfaces the denominator prominently instead of letting "87"
// over-read.
export const SparselyScored: Story = {
  args: {
    summary: computeStats(
      Array.from({ length: 40 }, (_, i) =>
        session({
          id: `sparse-${i}`,
          total_minutes: 30,
          started_at: NOW - i * DAY,
          score: i < 2 ? 87 : null,
          peer_pubkeys: JSON.stringify([ALICE]),
        })
      ),
      friends,
      NOW,
      'UTC'
    ),
    insights: computeInsights([], []),
  },
}
