import { useEffect, useState } from 'react'

import {
  SettingsLayout,
  type SettingsCategoryDescriptor,
} from '@/components/SettingsLayout'
import { useSettingsStore } from '@/stores/settingsStore'

import { AboutCategory } from './categories/AboutCategory'
import { AdvancedCategory } from './categories/AdvancedCategory'
import { AiCategory } from './categories/AiCategory'
import { AppearanceCategory } from './categories/AppearanceCategory'
import { FriendsCategory } from './categories/FriendsCategory'
import { IdentityCategory } from './categories/IdentityCategory'
import { NetworkCategory } from './categories/NetworkCategory'
import { NotificationsCategory } from './categories/NotificationsCategory'
import { SessionsCategory } from './categories/SessionsCategory'
import { ShortcutsCategory } from './categories/ShortcutsCategory'
import { StatsCategory } from './categories/StatsCategory'

export type SettingsCategoryId =
  | 'identity'
  | 'friends'
  | 'sessions'
  | 'stats'
  | 'appearance'
  | 'notifications'
  | 'shortcuts'
  | 'ai'
  | 'network'
  | 'advanced'
  | 'about'

const CATEGORIES: ReadonlyArray<
  SettingsCategoryDescriptor<SettingsCategoryId>
> = [
  { id: 'identity', label: 'Identity' },
  { id: 'friends', label: 'Friends' },
  { id: 'sessions', label: 'Sessions' },
  { id: 'stats', label: 'Stats' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'shortcuts', label: 'Shortcuts' },
  { id: 'ai', label: 'AI' },
  { id: 'network', label: 'Network' },
  { id: 'advanced', label: 'Advanced' },
  { id: 'about', label: 'About' },
]

export type SettingsProps = {
  onClose?: () => void
}

// Container: owns the active-category state and subscribes the settings
// store. Each category sub-component reads what it needs.
export function Settings({ onClose }: SettingsProps) {
  const [activeCategoryId, setActiveCategoryId] =
    useState<SettingsCategoryId>('identity')
  const hydrate = useSettingsStore((s) => s.hydrate)

  useEffect(() => {
    void hydrate()
  }, [hydrate])

  return (
    <SettingsLayout
      categories={CATEGORIES}
      activeCategoryId={activeCategoryId}
      onCategorySelect={setActiveCategoryId}
      onClose={onClose}
    >
      {activeCategoryId === 'identity' ? <IdentityCategory /> : null}
      {activeCategoryId === 'friends' ? <FriendsCategory /> : null}
      {activeCategoryId === 'sessions' ? <SessionsCategory /> : null}
      {activeCategoryId === 'stats' ? <StatsCategory /> : null}
      {activeCategoryId === 'appearance' ? <AppearanceCategory /> : null}
      {activeCategoryId === 'notifications' ? <NotificationsCategory /> : null}
      {activeCategoryId === 'shortcuts' ? <ShortcutsCategory /> : null}
      {activeCategoryId === 'ai' ? <AiCategory /> : null}
      {activeCategoryId === 'network' ? <NetworkCategory /> : null}
      {activeCategoryId === 'advanced' ? <AdvancedCategory /> : null}
      {activeCategoryId === 'about' ? <AboutCategory /> : null}
    </SettingsLayout>
  )
}
