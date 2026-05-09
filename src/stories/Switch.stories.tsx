import type { Meta, StoryObj } from '@storybook/react-vite'

import { Switch } from '@/components/ui/switch'

const meta = {
  title: 'UI/Switch',
  component: Switch,
  parameters: { layout: 'centered' },
} satisfies Meta<typeof Switch>

export default meta
type Story = StoryObj<typeof meta>

export const Off: Story = {}
export const On: Story = { args: { defaultChecked: true } }
export const Disabled: Story = { args: { disabled: true } }
export const Small: Story = { args: { size: 'sm', defaultChecked: true } }

export const AllSizes: Story = {
  render: () => (
    <div className="flex items-center gap-4">
      <Switch size="sm" />
      <Switch size="sm" defaultChecked />
      <Switch />
      <Switch defaultChecked />
    </div>
  ),
}
