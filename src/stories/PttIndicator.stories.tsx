import type { Meta, StoryObj } from '@storybook/react-vite'

import { PttIndicator } from '@/components/PttIndicator'

const meta = {
  title: 'Components/PttIndicator',
  component: PttIndicator,
  parameters: { layout: 'centered' },
  args: { active: true },
} satisfies Meta<typeof PttIndicator>

export default meta
type Story = StoryObj<typeof meta>

export const Active: Story = { args: { active: true } }
export const Idle: Story = { args: { active: false } }
