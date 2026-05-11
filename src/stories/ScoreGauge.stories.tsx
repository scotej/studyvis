import type { Meta, StoryObj } from '@storybook/react-vite'

import { ScoreGauge } from '@/components/ScoreGauge'

const meta = {
  title: 'Components/ScoreGauge',
  component: ScoreGauge,
  parameters: { layout: 'centered' },
  args: {
    score: 87,
    // Animation disabled by default so the visual is deterministic across
    // story snapshots; the Reveal story explicitly enables it.
    animate: false,
  },
} satisfies Meta<typeof ScoreGauge>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const Perfect: Story = {
  args: { score: 100 },
}

export const Halfway: Story = {
  args: { score: 50 },
}

export const Floor: Story = {
  args: { score: 0 },
}

export const Compact: Story = {
  args: { size: 120 },
}

// Plays the §6 motion rule #5 sweep on mount — useful for QA-ing the
// reveal duration + spring easing.
export const Reveal: Story = {
  args: { animate: true },
}
