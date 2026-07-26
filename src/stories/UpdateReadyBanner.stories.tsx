import type { Meta, StoryObj } from '@storybook/react-vite'

import {
  UpdateBlockedBannerView,
  UpdateReadyBannerView,
} from '@/components/UpdateReadyBanner'

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

// Issue #77 — the app is running somewhere it can't swap its own bundle
// (macOS: opened straight from the mounted .dmg), so instead of a Restart
// that would always error, the banner carries the move-to-Applications
// instruction and only offers an acknowledgement.
export const Blocked: Story = {
  render: (args) => (
    <UpdateBlockedBannerView version={args.version} onDismiss={() => {}} />
  ),
}
