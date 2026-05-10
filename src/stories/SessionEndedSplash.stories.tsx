import type { Meta, StoryObj } from '@storybook/react-vite'

import { SessionEndedSplash } from '@/components/SessionEndedSplash'

const meta = {
  title: 'Feature/SessionEndedSplash',
  component: SessionEndedSplash,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof SessionEndedSplash>

export default meta
type Story = StoryObj<typeof meta>

// Durations are in seconds (matching lifecycle.ts's `durationSeconds`
// computation) — 1500s ≠ "session ended" UX; using realistic session
// lengths so the formatted "25 min 00 s" output renders the way the
// production code will produce it.

export const Solo: Story = {
  // ~25-minute solo session (one Pomodoro work block).
  args: {
    durationSeconds: 25 * 60,
    peerNames: [],
  },
}

export const OnePeer: Story = {
  // 25 min 25 s with one peer — covers the seconds-aware label path.
  args: {
    durationSeconds: 25 * 60 + 25,
    peerNames: ['Alice'],
  },
}

export const TwoPeers: Story = {
  // 50-minute focus block with two peers.
  args: {
    durationSeconds: 50 * 60,
    peerNames: ['Alice', 'Bo'],
  },
}

export const ThreePeers: Story = {
  // 60 min 25 s session at full mesh (host + 3 peers).
  args: {
    durationSeconds: 60 * 60 + 25,
    peerNames: ['Alice', 'Bo', 'Mei'],
  },
}

export const QuickLeave: Story = {
  // Sub-minute leave (e.g. mis-clicked Invite) — exercises the
  // "23 seconds" branch of formatDuration.
  args: {
    durationSeconds: 23,
    peerNames: ['Alice'],
  },
}
