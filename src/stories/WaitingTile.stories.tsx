import type { Meta, StoryObj } from '@storybook/react-vite'

import { VideoTile } from '@/components/VideoTile'
import { WaitingTile } from '@/components/WaitingTile'

// U2 — the "waiting for your friend" tile shown alongside the self tile when
// you're alone in an active session (DESIGN-SYSTEM §10 empty-state: no spinner).
const meta = {
  title: 'Components/WaitingTile',
  component: WaitingTile,
  parameters: { layout: 'padded' },
} satisfies Meta<typeof WaitingTile>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  render: () => (
    <div className="w-full max-w-md">
      <WaitingTile />
    </div>
  ),
}

// U2×S1 — a friend who'd joined dropped (during the S1 grace window): reconnect
// copy rather than the never-had-peers invite copy.
export const Reconnect: Story = {
  render: () => (
    <div className="w-full max-w-md">
      <WaitingTile variant="reconnect" />
    </div>
  ),
}

// In context — the self tile + the waiting tile side by side, the exact
// first-session-alone layout SessionView renders.
export const AlongsideSelfTile: Story = {
  render: () => (
    <div className="grid w-full max-w-3xl grid-cols-2 gap-4">
      <VideoTile name="You" stream={null} isLocal />
      <WaitingTile />
    </div>
  ),
}
