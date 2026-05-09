import type { Meta, StoryObj } from '@storybook/react-vite'

import { Separator } from '@/components/ui/separator'

const meta = {
  title: 'UI/Separator',
  component: Separator,
  parameters: { layout: 'centered' },
} satisfies Meta<typeof Separator>

export default meta
type Story = StoryObj<typeof meta>

export const Horizontal: Story = {
  render: () => (
    <div className="w-72">
      <Separator />
    </div>
  ),
}

export const Vertical: Story = {
  render: () => (
    <div className="flex h-12 items-center gap-4">
      <span className="text-sm text-text-secondary">Section A</span>
      <Separator orientation="vertical" />
      <span className="text-sm text-text-secondary">Section B</span>
    </div>
  ),
}
