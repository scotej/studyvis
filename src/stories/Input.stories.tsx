import type { Meta, StoryObj } from '@storybook/react-vite'

import { Input } from '@/components/ui/input'
import { strings } from '@/strings'

const meta = {
  title: 'UI/Input',
  component: Input,
  parameters: { layout: 'centered' },
  args: {
    placeholder: 'placeholder',
    'aria-label': strings.settings.identity.displayName.ariaLabel,
  },
  decorators: [
    (Story) => (
      <div className="w-72">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof Input>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
export const Disabled: Story = { args: { disabled: true } }
export const Error: Story = { args: { 'aria-invalid': true } }
export const Focused: Story = {
  args: { autoFocus: true, defaultValue: 'focused' },
}

export const AllStates: Story = {
  render: () => (
    <div className="flex w-72 flex-col gap-3">
      <Input
        placeholder="default"
        aria-label={strings.settings.identity.displayName.ariaLabel}
      />
      <Input
        defaultValue="filled"
        aria-label={strings.settings.identity.displayName.ariaLabel}
      />
      <Input
        disabled
        placeholder="disabled"
        aria-label={strings.settings.identity.displayName.ariaLabel}
      />
      <Input
        aria-invalid
        placeholder="error"
        aria-label={strings.settings.identity.displayName.ariaLabel}
      />
    </div>
  ),
}
