import { useEffect, useState } from 'react'

import {
  SettingsLayout,
  type SettingsCategoryDescriptor,
} from '@/components/SettingsLayout'
import { useSettingsStore } from '@/stores/settingsStore'
import { strings } from '@/strings'

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
  { id: 'identity', label: strings.settings.nav.identity },
  { id: 'friends', label: strings.settings.nav.friends },
  { id: 'sessions', label: strings.settings.nav.sessions },
  { id: 'stats', label: strings.settings.nav.stats },
  { id: 'appearance', label: strings.settings.nav.appearance },
  { id: 'notifications', label: strings.settings.nav.notifications },
  { id: 'shortcuts', label: strings.settings.nav.shortcuts },
  { id: 'ai', label: strings.settings.nav.ai },
  { id: 'network', label: strings.settings.nav.network },
  { id: 'advanced', label: strings.settings.nav.advanced },
  { id: 'about', label: strings.settings.nav.about },
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
