import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, within } from 'storybook/test'

import { Progress } from '@/components/ui/progress'
import { strings } from '@/strings'

const meta = {
  title: 'UI/Progress',
  component: Progress,
  parameters: { layout: 'centered' },
  args: { 'aria-label': strings.updater.settings.downloadingLabel },
  play: async ({ args, canvasElement }) => {
    await expect(
      within(canvasElement).getByRole('progressbar')
    ).toHaveAttribute('aria-valuenow', String(args.value))
  },
  decorators: [
    (Story) => (
      <div className="w-72">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof Progress>

export default meta
type Story = StoryObj<typeof meta>

export const Empty: Story = { args: { value: 0 } }
export const Half: Story = { args: { value: 50 } }
export const Full: Story = { args: { value: 100 } }
