import type { Meta, StoryObj } from '@storybook/react-vite'

import { UpdateReadyBannerView } from '@/components/UpdateReadyBanner'

const meta = {
  title: 'Components/UpdateReadyBanner',
  component: UpdateReadyBannerView,
  parameters: { layout: 'padded' },
  args: {
    version: '1.5.0',
    installing: false,
    onRestart: () => {},
    onDismiss: () => {},
  },
} satisfies Meta<typeof UpdateReadyBannerView>

export default meta
type Story = StoryObj<typeof meta>

export const Ready: Story = {}

// Both buttons go disabled the moment the bundle swap starts — the restart is
// not cancellable once the installer has the files.
export const Installing: Story = {
  args: { installing: true },
}

export const LongVersionString: Story = {
  args: { version: '1.5.0-rc.1' },
}
