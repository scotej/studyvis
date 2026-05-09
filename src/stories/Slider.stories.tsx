import type { Meta, StoryObj } from '@storybook/react-vite'

import { Slider } from '@/components/ui/slider'

const meta = {
  title: 'UI/Slider',
  component: Slider,
  parameters: { layout: 'centered' },
  decorators: [
    (Story) => (
      <div className="w-72">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof Slider>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  args: { defaultValue: [50], max: 100, step: 1 },
}
export const Range: Story = {
  args: { defaultValue: [25, 75], max: 100, step: 1 },
}
export const Disabled: Story = {
  args: { defaultValue: [40], disabled: true },
}
