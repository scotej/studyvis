import type { Meta, StoryObj } from '@storybook/react-vite'

import { SelfWarningBadge } from '@/components/SelfWarningBadge'

const meta = {
  title: 'Components/SelfWarningBadge',
  component: SelfWarningBadge,
  // Use fullscreen so the fixed-position badge anchors to the
  // bottom-right of the canvas — same behavior as inside a real session.
  parameters: { layout: 'fullscreen' },
  args: { reasoning: 'Looking away from the screen.' },
} satisfies Meta<typeof SelfWarningBadge>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const LongReasoning: Story = {
  args: {
    reasoning:
      'Eyes pointed away from monitor for several seconds while another tab was visible — looks like an idle moment rather than a context switch.',
  },
}
