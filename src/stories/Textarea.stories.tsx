import type { Meta, StoryObj } from '@storybook/react-vite'

import { Textarea } from '@/components/ui/textarea'

const meta = {
  title: 'UI/Textarea',
  component: Textarea,
  parameters: { layout: 'centered' },
  args: { placeholder: 'Type here…' },
  decorators: [
    (Story) => (
      <div className="w-72">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof Textarea>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
export const Disabled: Story = { args: { disabled: true } }
export const Error: Story = { args: { 'aria-invalid': true } }
