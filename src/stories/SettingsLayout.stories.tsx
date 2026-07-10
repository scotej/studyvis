import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'

import {
  SettingsLayout,
  type SettingsCategoryDescriptor,
} from '@/components/SettingsLayout'
import { SettingsRow, SettingsSection } from '@/components/SettingsRow'
import { Switch } from '@/components/ui/switch'

type CategoryId =
  | 'identity'
  | 'friends'
  | 'sessions'
  | 'appearance'
  | 'notifications'
  | 'shortcuts'
  | 'network'
  | 'advanced'

const CATEGORIES: ReadonlyArray<SettingsCategoryDescriptor<CategoryId>> = [
  { id: 'identity', label: 'Identity' },
  { id: 'friends', label: 'Friends' },
  { id: 'sessions', label: 'Sessions' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'shortcuts', label: 'Shortcuts' },
  { id: 'network', label: 'Network' },
  { id: 'advanced', label: 'Advanced' },
]

const meta = {
  title: 'Components/SettingsLayout',
  parameters: { layout: 'fullscreen' },
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

export const Appearance: Story = {
  render: () => {
    const [active, setActive] = useState<CategoryId>('appearance')
    return (
      <SettingsLayout
        categories={CATEGORIES}
        activeCategoryId={active}
        onCategorySelect={(id) => setActive(id as CategoryId)}
        onClose={() => {}}
      >
        <SettingsSection heading="Appearance">
          <SettingsRow
            label="Reduce motion"
            help="Replaces transitions with fades."
            control={<Switch />}
          />
        </SettingsSection>
      </SettingsLayout>
    )
  },
}

export const NoCloseButton: Story = {
  render: () => {
    const [active, setActive] = useState<CategoryId>('identity')
    return (
      <SettingsLayout
        categories={CATEGORIES}
        activeCategoryId={active}
        onCategorySelect={(id) => setActive(id as CategoryId)}
      >
        <SettingsSection heading="Identity">
          <SettingsRow
            label="Display name"
            help="Friends see this name next to your tile."
            control={<span className="text-sm text-text-secondary">Sam</span>}
          />
        </SettingsSection>
      </SettingsLayout>
    )
  },
}
