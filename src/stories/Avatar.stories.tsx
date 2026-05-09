import type { Meta, StoryObj } from '@storybook/react-vite'

import { Avatar, AvatarFallback } from '@/components/ui/avatar'

const meta = {
  title: 'UI/Avatar',
  component: Avatar,
  parameters: { layout: 'centered' },
} satisfies Meta<typeof Avatar>

export default meta
type Story = StoryObj<typeof meta>

export const Small: Story = {
  render: () => (
    <Avatar size="sm">
      <AvatarFallback>SA</AvatarFallback>
    </Avatar>
  ),
}

export const Default: Story = {
  render: () => (
    <Avatar>
      <AvatarFallback>AL</AvatarFallback>
    </Avatar>
  ),
}

export const Large: Story = {
  render: () => (
    <Avatar size="lg">
      <AvatarFallback>BO</AvatarFallback>
    </Avatar>
  ),
}

export const AllSizes: Story = {
  render: () => (
    <div className="flex items-end gap-4">
      <Avatar size="sm">
        <AvatarFallback>SA</AvatarFallback>
      </Avatar>
      <Avatar>
        <AvatarFallback>AL</AvatarFallback>
      </Avatar>
      <Avatar size="lg">
        <AvatarFallback>BO</AvatarFallback>
      </Avatar>
    </div>
  ),
}
