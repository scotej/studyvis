import type { Meta, StoryObj } from '@storybook/react-vite'

import { FocusIndicator } from '@/components/FocusIndicator'

const meta = {
  title: 'Components/FocusIndicator',
  component: FocusIndicator,
  parameters: { layout: 'centered' },
  args: { state: 'focused' },
} satisfies Meta<typeof FocusIndicator>

export default meta
type Story = StoryObj<typeof meta>

export const Focused: Story = { args: { state: 'focused' } }
export const Warning: Story = { args: { state: 'warning' } }
export const Alerted: Story = { args: { state: 'alerted' } }
export const Offline: Story = { args: { state: 'offline' } }

export const AllStates: Story = {
  render: () => (
    <div className="flex items-center gap-3">
      <FocusIndicator state="focused" />
      <FocusIndicator state="warning" />
      <FocusIndicator state="alerted" />
      <FocusIndicator state="offline" />
    </div>
  ),
}
