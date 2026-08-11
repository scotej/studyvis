import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, within } from 'storybook/test'

import { VideoTile } from '@/components/VideoTile'
import { WaitingTile } from '@/components/WaitingTile'
import { strings } from '@/strings'

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

// A friend who had joined has left or disconnected. The remaining participant
// can keep studying indefinitely and sees durable solo-session copy.
export const Solo: Story = {
  render: () => (
    <div className="w-full max-w-md">
      <WaitingTile variant="solo" />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      canvas.getByText(strings.session.waiting.soloTitle)
    ).toBeVisible()
    await expect(
      canvas.getByText(strings.session.waiting.soloBody)
    ).toBeVisible()
  },
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
