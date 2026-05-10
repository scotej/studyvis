import type { Meta, StoryObj } from '@storybook/react-vite'

import { SessionEndedSplash } from '@/components/SessionEndedSplash'

const meta = {
  title: 'Feature/SessionEndedSplash',
  component: SessionEndedSplash,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof SessionEndedSplash>

export default meta
type Story = StoryObj<typeof meta>

export const Solo: Story = {
  args: {
    durationSeconds: 1500,
    peerNames: [],
  },
}

export const OnePeer: Story = {
  args: {
    durationSeconds: 1525,
    peerNames: ['Alice'],
  },
}

export const TwoPeers: Story = {
  args: {
    durationSeconds: 3000,
    peerNames: ['Alice', 'Bo'],
  },
}

export const ThreePeers: Story = {
  args: {
    durationSeconds: 3625,
    peerNames: ['Alice', 'Bo', 'Mei'],
  },
}

export const QuickLeave: Story = {
  args: {
    durationSeconds: 23,
    peerNames: ['Alice'],
  },
}
