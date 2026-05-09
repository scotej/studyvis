import type { Meta, StoryObj } from '@storybook/react-vite'

import { Kbd } from '@/components/ui/kbd'

const meta = {
  title: 'UI/Kbd',
  component: Kbd,
  parameters: { layout: 'centered' },
  args: { children: 'K' },
} satisfies Meta<typeof Kbd>

export default meta
type Story = StoryObj<typeof meta>

export const Single: Story = {}

export const Combo: Story = {
  render: () => (
    <div className="flex items-center gap-1.5">
      <Kbd>⌘</Kbd>
      <span className="text-text-secondary">+</span>
      <Kbd>[</Kbd>
    </div>
  ),
}
