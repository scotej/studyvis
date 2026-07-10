import type { Meta, StoryObj } from '@storybook/react-vite'

import { computeInsights, FocusInsights } from '@/features/stats'
import type { AuditEventRecord } from '@/lib/db/audit'
import type { SessionRecord } from '@/lib/db/sessions'

// Render the pure view directly with synthetic data — same pattern as
// Dashboard.stories.tsx. The decorator reproduces the Stats category width so
// the trend line + timing bars are verified under the real constraint.
const meta = {
  title: 'Features/Stats/FocusInsights',
  component: FocusInsights,
  parameters: { layout: 'padded' },
  decorators: [
    (Story) => (
      <div className="mx-auto w-full max-w-2xl rounded-lg border border-border-subtle bg-bg-base px-8 py-8">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof FocusInsights>

export default meta
type Story = StoryObj<typeof meta>

const DAY = 86_400_000
const NOW = Date.UTC(2026, 4, 18, 12, 0, 0)
const ALICE = 'a'.repeat(64)

let n = 0
function session(over: Partial<SessionRecord> = {}): SessionRecord {
  n += 1
  return {
    id: `ins-${n}`,
    started_at: NOW,
    ended_at: null,
    total_minutes: 30,
    peer_pubkeys: null,
    declared_topic: null,
    score: null,
    focused_pct: null,
    generated_at: null,
    confident_samples: null,
    skipped_samples: null,
    ...over,
  }
}

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

// No AI-scored sessions and no distraction events — the calm §10 empty state.
export const Empty: Story = {
  args: { insights: computeInsights([], []) },
}

// A few sessions with focus scores but no logged distractions — the trend
// renders under the single shared no-distractions card.
export const TrendOnly: Story = {
  args: {
    insights: computeInsights(
      Array.from({ length: 6 }, (_, i) =>
        session({
          id: `trend-${i}`,
          started_at: NOW - i * DAY,
          focused_pct: 0.7 + (i % 3) * 0.08,
        })
      ),
      []
    ),
  },
}

// Fully populated: distractions clustered early/mid/late, recurring reasons,
// and a focus trend across scored sessions.
const populatedSessions = Array.from({ length: 10 }, (_, i) =>
  session({
    id: `pop-${i}`,
    started_at: NOW - i * DAY,
    focused_pct: 0.55 + ((i * 7) % 35) / 100,
  })
)

const populatedAudit: AuditEventRecord[] = populatedSessions.flatMap((s, i) =>
  s.started_at == null
    ? []
    : [
        distraction(s.id, s.started_at, 4, 'scrolling social media'),
        distraction(s.id, s.started_at, 8, 'scrolling social media'),
        ...(i % 2 === 0
          ? [distraction(s.id, s.started_at, 25, 'watching a video')]
          : []),
        ...(i % 3 === 0
          ? [distraction(s.id, s.started_at, 52, 'phone notifications')]
          : []),
      ]
)

export const Populated: Story = {
  args: { insights: computeInsights(populatedSessions, populatedAudit) },
}
