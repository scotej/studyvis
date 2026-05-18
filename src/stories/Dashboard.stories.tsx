import type { Meta, StoryObj } from '@storybook/react-vite'

import { computeStats, DashboardView } from '@/features/stats'
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

// 0 sessions — the calm empty state (DESIGN-SYSTEM.md §10).
export const Empty: Story = {
  args: { summary: computeStats([], [], NOW, 'UTC') },
}

// 1 session — a single bar, a one-day streak, one partner, one score.
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
  },
}

// 30+ sessions — a busy month: a session most days (some days double),
// alternating partners, ~70% scored. Verifies the full chart + axis
// thinning at the production width.
export const PopulatedMonth: Story = {
  args: {
    summary: computeStats(
      Array.from({ length: 38 }, (_, i) => {
        const daysBack = Math.floor(i / 1.4) // some days get two sessions
        return session({
          total_minutes: 20 + ((i * 7) % 45),
          started_at: NOW - daysBack * DAY,
          score: i % 3 === 0 ? null : 70 + ((i * 5) % 30),
          peer_pubkeys: JSON.stringify([i % 2 === 0 ? ALICE : BO]),
        })
      }),
      friends,
      NOW,
      'UTC'
    ),
  },
}
