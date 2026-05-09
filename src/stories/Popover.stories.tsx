import type { Meta, StoryObj } from '@storybook/react-vite'

import { Button } from '@/components/ui/button'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'

const meta = {
  title: 'UI/Popover',
  component: Popover,
  parameters: { layout: 'centered' },
} satisfies Meta<typeof Popover>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  render: () => (
    <Popover>
      <PopoverTrigger asChild>
        <Button>Open popover</Button>
      </PopoverTrigger>
      <PopoverContent>
        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium">Popover</p>
          <p className="text-sm text-text-secondary">
            Floating content anchored to the trigger.
          </p>
        </div>
      </PopoverContent>
    </Popover>
  ),
}
