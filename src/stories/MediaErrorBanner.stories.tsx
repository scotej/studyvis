import type { Meta, StoryObj } from '@storybook/react-vite'

import { MediaErrorBanner } from '@/components/MediaErrorBanner'

const meta = {
  title: 'Components/MediaErrorBanner',
  component: MediaErrorBanner,
  parameters: { layout: 'padded' },
  args: {
    errorName: 'NotAllowedError',
    onRetry: () => {},
  },
} satisfies Meta<typeof MediaErrorBanner>

export default meta
type Story = StoryObj<typeof meta>

export const PermissionDenied: Story = {
  args: {
    errorName: 'NotAllowedError',
    onOpenSettings: () => {},
  },
}

export const NoDeviceFound: Story = {
  args: { errorName: 'NotFoundError' },
}

export const DeviceInUse: Story = {
  args: { errorName: 'NotReadableError' },
}

export const Overconstrained: Story = {
  args: { errorName: 'OverconstrainedError' },
}

export const Generic: Story = {
  args: { errorName: 'AbortError' },
}
