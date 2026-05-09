import type { Meta, StoryObj } from '@storybook/react-vite'

import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

const meta = {
  title: 'UI/Label',
  component: Label,
  parameters: { layout: 'centered' },
} satisfies Meta<typeof Label>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  render: () => (
    <div className="flex w-72 flex-col gap-2">
      <Label htmlFor="x">Display name</Label>
      <Input id="x" placeholder="Sam" />
    </div>
  ),
}
