import type { Meta, StoryObj } from '@storybook/react-vite'

import { Logo } from '@/components/Logo'

const meta = {
  title: 'Components/Logo',
  component: Logo,
  parameters: { layout: 'centered' },
  args: { size: 'md' },
  argTypes: {
    size: {
      control: 'select',
      options: ['sm', 'md', 'lg', 'xl'],
    },
    monochrome: { control: 'boolean' },
  },
} satisfies Meta<typeof Logo>

export default meta
type Story = StoryObj<typeof meta>

export const Small: Story = { args: { size: 'sm' } }
export const Medium: Story = { args: { size: 'md' } }
export const Large: Story = { args: { size: 'lg' } }
export const ExtraLarge: Story = { args: { size: 'xl' } }

export const Monochrome: Story = { args: { size: 'lg', monochrome: true } }

export const AllSizes: Story = {
  render: () => (
    <div className="flex items-end gap-6">
      <Logo size="sm" />
      <Logo size="md" />
      <Logo size="lg" />
      <Logo size="xl" />
    </div>
  ),
}
