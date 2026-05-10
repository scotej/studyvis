import type { Meta, StoryObj } from '@storybook/react-vite'

import { ScreenCapturePermissionOverlay } from '@/components/ScreenCapturePermissionOverlay'

const meta = {
  title: 'Feature/ScreenCapturePermissionOverlay',
  component: ScreenCapturePermissionOverlay,
  parameters: { layout: 'centered' },
  args: {
    open: true,
  },
} satisfies Meta<typeof ScreenCapturePermissionOverlay>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  args: {
    onOpenChange: () => {},
  },
}

export const WithRetry: Story = {
  args: {
    onOpenChange: () => {},
    onRetry: () => {},
  },
}
