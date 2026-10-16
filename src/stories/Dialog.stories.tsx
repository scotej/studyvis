import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, waitFor, within } from 'storybook/test'

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
        <Input
          aria-label="Pairing code"
          placeholder="ocean ladder cinnamon …"
        />
        <DialogFooter showCloseButton />
      </DialogContent>
    </Dialog>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const body = within(canvasElement.ownerDocument.body)
    const trigger = canvas.getByRole('button', { name: 'Open dialog' })
    await userEvent.click(trigger)
    const dialog = await body.findByRole('dialog', { name: 'Add a friend' })
    const input = within(dialog).getByRole('textbox', { name: 'Pairing code' })
    await waitFor(() => expect(input).toHaveFocus())
    for (let i = 0; i < 5; i++) {
      await userEvent.tab()
      await expect(dialog).toContainElement(
        canvasElement.ownerDocument.activeElement as HTMLElement
      )
    }
    await userEvent.keyboard('{Escape}')
    await waitFor(() =>
      expect(body.queryByRole('dialog')).not.toBeInTheDocument()
    )
    await expect(trigger).toHaveFocus()
    // Leave the portal open so the runner's completed axe audit includes it.
    await userEvent.click(trigger)
    await body.findByRole('dialog', { name: 'Add a friend' })
  },
}
