import type { Meta, StoryObj } from '@storybook/react-vite'

import { AdvancedCategory } from '@/features/settings/categories/AdvancedCategory'
import { AppearanceCategory } from '@/features/settings/categories/AppearanceCategory'
import { FriendsCategory } from '@/features/settings/categories/FriendsCategory'
import { IdentityCategory } from '@/features/settings/categories/IdentityCategory'
import { NetworkCategory } from '@/features/settings/categories/NetworkCategory'
import { NotificationsCategory } from '@/features/settings/categories/NotificationsCategory'
import { SessionsCategory } from '@/features/settings/categories/SessionsCategory'
import { ShortcutsCategory } from '@/features/settings/categories/ShortcutsCategory'

// Each category renders its own data dependency (settings store, friends
// store, identity hook, etc.). Outside Tauri the Tauri-backed hooks fall
// through to safe empty states — which is exactly what makes these stories
// useful as a visual smoke check before each release.

const meta = {
  title: 'Features/Settings/Category',
  parameters: { layout: 'padded' },
  decorators: [
    (Story) => (
      <div className="mx-auto w-full max-w-2xl rounded-lg border border-border-subtle bg-bg-base px-8 py-8">
        <Story />
      </div>
    ),
  ],
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

export const Identity: Story = {
  render: () => <IdentityCategory />,
}

export const Friends: Story = {
  render: () => <FriendsCategory />,
}

export const Sessions: Story = {
  render: () => <SessionsCategory />,
}

export const Appearance: Story = {
  render: () => <AppearanceCategory />,
}

export const Notifications: Story = {
  render: () => <NotificationsCategory />,
}

export const Shortcuts: Story = {
  render: () => <ShortcutsCategory />,
}

export const Network: Story = {
  render: () => <NetworkCategory />,
}

export const Advanced: Story = {
  render: () => <AdvancedCategory />,
}
