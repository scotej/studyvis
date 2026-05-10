import type { Meta, StoryObj } from '@storybook/react-vite'

import { AudioDevicePicker } from '@/components/AudioDevicePicker'

const meta = {
  title: 'Feature/AudioDevicePicker',
  component: AudioDevicePicker,
  parameters: { layout: 'centered' },
  args: {
    currentDeviceId: null,
    swapping: false,
    onSelect: () => {},
  },
} satisfies Meta<typeof AudioDevicePicker>

export default meta
type Story = StoryObj<typeof meta>

// enumerateDevices is browser-only, so Storybook will render the empty
// state unless the user has granted mic permission to Storybook. The story
// still verifies layout + trigger styling.
export const Default: Story = {}

export const Swapping: Story = {
  args: {
    swapping: true,
  },
}
