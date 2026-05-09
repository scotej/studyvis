import type { Meta, StoryObj } from '@storybook/react-vite'

import { Button } from '@/components/ui/button'

const meta = {
  title: 'UI/Button',
  component: Button,
  parameters: { layout: 'centered' },
  args: { children: 'Button' },
  argTypes: {
    variant: {
      control: 'select',
      options: [
        'default',
        'secondary',
        'destructive',
        'outline',
        'ghost',
        'link',
      ],
    },
    size: {
      control: 'select',
      options: ['default', 'sm', 'lg', 'icon'],
    },
  },
} satisfies Meta<typeof Button>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
export const Secondary: Story = { args: { variant: 'secondary' } }
export const Ghost: Story = { args: { variant: 'ghost' } }
export const Destructive: Story = { args: { variant: 'destructive' } }
export const Outline: Story = { args: { variant: 'outline' } }
export const Link: Story = { args: { variant: 'link' } }

export const SmallSize: Story = { args: { size: 'sm' } }
export const LargeSize: Story = { args: { size: 'lg' } }
export const IconSize: Story = { args: { size: 'icon', children: '✦' } }

export const AllVariants: Story = {
  render: () => (
    <div className="flex flex-wrap gap-3">
      <Button>Default</Button>
      <Button variant="secondary">Secondary</Button>
      <Button variant="ghost">Ghost</Button>
      <Button variant="outline">Outline</Button>
      <Button variant="destructive">Destructive</Button>
      <Button variant="link">Link</Button>
    </div>
  ),
}

export const AllSizes: Story = {
  render: () => (
    <div className="flex flex-wrap items-center gap-3">
      <Button size="sm">Small</Button>
      <Button>Default</Button>
      <Button size="lg">Large</Button>
      <Button size="icon" aria-label="icon">
        ✦
      </Button>
    </div>
  ),
}
