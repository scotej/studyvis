import type { Meta, StoryObj } from '@storybook/react-vite'

import { FocusIndicator, type FocusState } from '@/components/FocusIndicator'

const meta = {
  title: 'Components/FocusIndicator',
  component: FocusIndicator,
  parameters: { layout: 'centered' },
  args: { state: 'focused' },
} satisfies Meta<typeof FocusIndicator>

export default meta
type Story = StoryObj<typeof meta>

export const Online: Story = { args: { state: 'online' } }
export const OnBreak: Story = { args: { state: 'on_break' } }
export const Focused: Story = { args: { state: 'focused' } }
export const Warning: Story = { args: { state: 'warning' } }
export const Alerted: Story = { args: { state: 'alerted' } }
export const Offline: Story = { args: { state: 'offline' } }

const ALL_STATES: FocusState[] = [
  'online',
  'on_break',
  'focused',
  'warning',
  'alerted',
  'offline',
]

export const AllStates: Story = {
  render: () => (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        {ALL_STATES.map((state) => (
          <FocusIndicator key={`sm-${state}`} state={state} size="sm" />
        ))}
      </div>
      <div className="flex items-center gap-3">
        {ALL_STATES.map((state) => (
          <FocusIndicator key={`md-${state}`} state={state} size="md" />
        ))}
      </div>
    </div>
  ),
}
