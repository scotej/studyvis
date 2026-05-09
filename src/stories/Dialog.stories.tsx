import type { Meta, StoryObj } from '@storybook/react-vite'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'

const meta = {
  title: 'UI/Dialog',
  component: Dialog,
  parameters: { layout: 'centered' },
} satisfies Meta<typeof Dialog>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  render: () => (
    <Dialog>
      <DialogTrigger asChild>
        <Button>Open dialog</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a friend</DialogTitle>
          <DialogDescription>
            Paste their 12-word pairing code.
          </DialogDescription>
        </DialogHeader>
        <Input placeholder="ocean ladder cinnamon …" />
        <DialogFooter showCloseButton />
      </DialogContent>
    </Dialog>
  ),
}
