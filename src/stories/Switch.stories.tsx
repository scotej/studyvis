import type { Meta, StoryObj } from '@storybook/react-vite'

import { Switch } from '@/components/ui/switch'
import { strings } from '@/strings'

const meta = {
  title: 'UI/Switch',
  component: Switch,
  parameters: { layout: 'centered' },
  args: { 'aria-label': strings.settings.notifications.invites.ariaLabel },
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
      <Switch
        size="sm"
        aria-label={strings.settings.notifications.invites.ariaLabel}
      />
      <Switch
        size="sm"
        defaultChecked
        aria-label={strings.settings.notifications.invites.ariaLabel}
      />
      <Switch aria-label={strings.settings.notifications.invites.ariaLabel} />
      <Switch
        defaultChecked
        aria-label={strings.settings.notifications.invites.ariaLabel}
      />
    </div>
  ),
}
