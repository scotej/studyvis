import type { Meta, StoryObj } from '@storybook/react-vite'

import { AiStatusChip } from '@/components/AiStatusChip'

const meta = {
  title: 'Components/AiStatusChip',
  component: AiStatusChip,
  parameters: { layout: 'centered' },
  args: { status: 'active' },
} satisfies Meta<typeof AiStatusChip>

export default meta
type Story = StoryObj<typeof meta>

export const Off: Story = { args: { status: 'off' } }
export const Active: Story = { args: { status: 'active' } }
export const Paused: Story = { args: { status: 'paused' } }
export const Error: Story = { args: { status: 'error' } }

export const AllStates: Story = {
  render: () => (
    <div className="flex items-center gap-4">
      <AiStatusChip status="off" />
      <AiStatusChip status="active" />
      <AiStatusChip status="paused" />
      <AiStatusChip status="error" />
    </div>
  ),
}
