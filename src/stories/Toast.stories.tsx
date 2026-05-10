import type { Meta, StoryObj } from '@storybook/react-vite'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Toaster } from '@/components/ui/sonner'

const meta = {
  title: 'UI/Toast',
  component: Toaster,
  parameters: { layout: 'centered' },
} satisfies Meta<typeof Toaster>

export default meta
type Story = StoryObj<typeof meta>

export const Triggers: Story = {
  render: () => (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => toast('Bo joined the session.')}>Default</Button>
        <Button
          variant="outline"
          onClick={() => toast.success('Saved to disk.')}
        >
          Success
        </Button>
        <Button
          variant="outline"
          onClick={() => toast.error("Couldn't reach Alice.")}
        >
          Error
        </Button>
        <Button
          variant="outline"
          onClick={() =>
            toast('Heads up.', { description: 'Mei is now offline.' })
          }
        >
          With description
        </Button>
      </div>
      <Toaster position="bottom-right" />
    </div>
  ),
}
