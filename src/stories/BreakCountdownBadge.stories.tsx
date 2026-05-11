import type { Meta, StoryObj } from '@storybook/react-vite'

import { BreakCountdownBadge } from '@/components/BreakCountdownBadge'

const meta = {
  title: 'Components/BreakCountdownBadge',
  component: BreakCountdownBadge,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof BreakCountdownBadge>

export default meta
type Story = StoryObj<typeof meta>

export const FiveMinutes: Story = {
  args: { endsAt: Date.now() + 5 * 60 * 1000 },
}

export const OneMinute: Story = {
  args: { endsAt: Date.now() + 60 * 1000 },
}

export const TenSeconds: Story = {
  args: { endsAt: Date.now() + 10 * 1000 },
}
