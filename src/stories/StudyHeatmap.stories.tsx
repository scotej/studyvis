import type { Meta, StoryObj } from '@storybook/react-vite'

import { buildStudyHeatmap } from '@/features/stats/statsData'
import { StudyHeatmap } from '@/features/stats/StudyHeatmap'
import type { SessionRecord } from '@/lib/db/sessions'

// Renders the pure view over synthetic sessions, the same pattern as
// FocusInsights.stories.tsx. The decorator reproduces the width the Stats
// category renders at in production (Settings pane, max-w-2xl) so the
// 53-column grid is verified against the constraint that actually applies.
const meta = {
  title: 'Features/Stats/StudyHeatmap',
  component: StudyHeatmap,
  parameters: { layout: 'padded' },
  decorators: [
    (Story) => (
      <div className="mx-auto w-full max-w-2xl rounded-lg border border-border-subtle bg-bg-base px-8 py-8">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof StudyHeatmap>

export default meta
type Story = StoryObj<typeof meta>

const DAY = 86_400_000
const NOW = Date.UTC(2026, 6, 28, 12, 0, 0) // 2026-07-28T12:00:00Z, a Tuesday
const ZONE = 'UTC'
const LOCALE = 'en-US'

let n = 0
function session(daysAgo: number, minutes: number): SessionRecord {
  n += 1
  return {
    id: `story-heatmap-${n}`,
    started_at: NOW - daysAgo * DAY,
    ended_at: null,
    total_minutes: minutes,
    peer_pubkeys: null,
    declared_topic: null,
    score: null,
    focused_pct: null,
    generated_at: null,
    confident_samples: null,
    skipped_samples: null,
    ai_enabled: null,
  }
}

// A year of plausible study: most weekdays, longer on some, a three-week gap
// in the middle, and a dense recent stretch that shows the top of the scale.
function aYearOfStudy(): SessionRecord[] {
  const out: SessionRecord[] = []
  for (let daysAgo = 0; daysAgo < 360; daysAgo++) {
    const weekday = (daysAgo + 2) % 7
    if (weekday === 0 || weekday === 6) continue
    if (daysAgo > 150 && daysAgo < 172) continue
    const minutes =
      daysAgo % 11 === 0
        ? 150
        : daysAgo % 5 === 0
          ? 75
          : daysAgo % 3 === 0
            ? 40
            : 20
    out.push(session(daysAgo, minutes))
  }
  return out
}

export const AYearOfStudy: Story = {
  args: { heatmap: buildStudyHeatmap(aYearOfStudy(), NOW, ZONE, LOCALE) },
}

// The realistic new-user shape: a handful of days, most of the grid empty.
export const JustStarted: Story = {
  args: {
    heatmap: buildStudyHeatmap(
      [session(0, 45), session(1, 30), session(4, 20), session(5, 130)],
      NOW,
      ZONE,
      LOCALE
    ),
  },
}

// Sessions exist but none reached a whole minute, so there is nothing to
// colour — the section says so instead of drawing a year of grey.
export const NothingYet: Story = {
  args: { heatmap: buildStudyHeatmap([session(0, 0)], NOW, ZONE, LOCALE) },
}
