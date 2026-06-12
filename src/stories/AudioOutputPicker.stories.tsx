import type { Meta, StoryObj } from '@storybook/react-vite'

import { AudioOutputPicker } from '@/components/AudioOutputPicker'

// S4 — speaker/output device picker. Renders nothing when setSinkId is
// unsupported (macOS WKWebView); in a Chromium-backed Storybook it renders the
// trigger + (permission-gated) device list.
const meta = {
  title: 'Feature/AudioOutputPicker',
  component: AudioOutputPicker,
  parameters: { layout: 'centered' },
  args: {
    currentDeviceId: null,
    onSelect: () => {},
  },
} satisfies Meta<typeof AudioOutputPicker>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
