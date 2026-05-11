import type { Meta, StoryObj } from '@storybook/react-vite'

import { AiResponseBubble } from '@/components/AiResponseBubble'

const meta = {
  title: 'Components/AiResponseBubble',
  component: AiResponseBubble,
  parameters: { layout: 'centered' },
  args: { text: 'Approved · 5 min.', tone: 'approved' },
} satisfies Meta<typeof AiResponseBubble>

export default meta
type Story = StoryObj<typeof meta>

export const Approved: Story = {
  args: { tone: 'approved', text: 'Approved · 5 min. Resume after the timer.' },
}

export const Denied: Story = {
  args: {
    tone: 'denied',
    text: 'Last break was less than 25 minutes ago — try again in 18 min.',
  },
}

export const Neutral: Story = {
  args: {
    tone: 'neutral',
    text: 'Topic updated to Coding.',
  },
}
