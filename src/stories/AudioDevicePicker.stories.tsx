import type { Meta, StoryObj } from '@storybook/react-vite'
import { userEvent, waitFor, within } from 'storybook/test'

import { AudioDevicePicker } from '@/components/AudioDevicePicker'

// enumerateDevices is browser-only and Storybook has no mic permission, so
// the pickers would always render their empty state. Mock the device list at
// module scope — two devices deliberately share a label ("USB Audio
// Device"), the exact case where the open menu's checked row is the only
// way to tell the active device apart.
const FAKE_INPUTS = [
  { deviceId: 'mic-1', kind: 'audioinput', label: 'Built-in Microphone' },
  { deviceId: 'mic-2', kind: 'audioinput', label: 'USB Audio Device' },
  { deviceId: 'mic-3', kind: 'audioinput', label: 'USB Audio Device' },
].map((d) => ({ ...d, groupId: d.deviceId, toJSON: () => d }))

Object.defineProperty(globalThis.navigator, 'mediaDevices', {
  configurable: true,
  value: {
    enumerateDevices: async () => FAKE_INPUTS,
    addEventListener: () => {},
    removeEventListener: () => {},
  },
})

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

export const Default: Story = {}

export const Swapping: Story = {
  args: {
    swapping: true,
  },
}

// Open menu with a pinned device: the active row renders role=menuitemradio
// + aria-checked + the dot indicator (never color alone), replacing the old
// dead data-active attribute. The play function opens the menu so the axe
// gate audits the checked-row rendering.
export const OpenWithSelectedDevice: Story = {
  args: {
    currentDeviceId: 'mic-2',
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(await canvas.findByRole('button'))
    await waitFor(() => {
      const checked = document.querySelector(
        '[role="menuitemradio"][aria-checked="true"]'
      )
      if (!checked) throw new Error('checked device row not rendered yet')
    })
  },
}
