import type { Meta, StoryObj } from '@storybook/react-vite'

import { InterruptedSessionView } from '@/features/session/InterruptedSessionView'

// #225 — the full-screen launch decision after StudyVis closed mid-session.
// `now`/`startedAt` are fixed so the elapsed copy is deterministic for the
// axe pass and for visual review.
const NOW = 1_760_000_000_000
const noop = () => undefined

const meta = {
  title: 'Features/Session/InterruptedSession',
  component: InterruptedSessionView,
  parameters: { layout: 'fullscreen' },
  args: {
    now: NOW,
    startedAt: NOW - 18 * 60_000,
    studyTopic: 'Linear algebra problem set',
    onRejoin: noop,
    onEnd: noop,
  },
} satisfies Meta<typeof InterruptedSessionView>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

// The AI topic gate is off, so the session only ever carried the placeholder
// label and there is nothing worth naming back to the user.
export const WithoutTopic: Story = {
  args: { studyTopic: null },
}

export const StartedHoursAgo: Story = {
  args: { startedAt: NOW - 3 * 60 * 60_000 },
}

export const JustStarted: Story = {
  args: { startedAt: NOW - 5_000 },
}

export const Rejoining: Story = {
  args: { rejoining: true },
}
