import { useEffect, useState } from 'react'

import {
  SettingsLayout,
  type SettingsCategoryDescriptor,
} from '@/components/SettingsLayout'
import { Recover, useIdentity } from '@/features/identity'
import { Report } from '@/features/session'
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
  // A re-opened report must replace the settings shell entirely — rendering it
  // inside SettingsLayout would nest a second <main> landmark and squeeze the
  // report into the content column. Lift the selection here and branch above
  // the layout, mirroring Home.tsx's fresh-session-end mount.
  const [openSessionId, setOpenSessionId] = useState<string | null>(null)
  // D4 — "Restore a different identity" mounts the full-screen Recover flow.
  // Lifted here (not inside IdentityCategory) for the same landmark reason as
  // the report: OnboardingStep renders its own <main>, so it must replace the
  // settings shell rather than nest inside it.
  const [restoringIdentity, setRestoringIdentity] = useState(false)
  const { identity, actions } = useIdentity()
  const hydrate = useSettingsStore((s) => s.hydrate)

  useEffect(() => {
    void hydrate()
  }, [hydrate])

  if (restoringIdentity) {
    return (
      <Recover
        identityExists
        currentFingerprint={identity?.mnemonic_fingerprint}
        recover={actions.recover}
        onBack={() => setRestoringIdentity(false)}
        onRecovered={() => setRestoringIdentity(false)}
      />
    )
  }

  if (openSessionId) {
    return (
      <Report
        sessionId={openSessionId}
        onClose={() => setOpenSessionId(null)}
      />
    )
  }

  return (
    <SettingsLayout
      categories={CATEGORIES}
      activeCategoryId={activeCategoryId}
      onCategorySelect={setActiveCategoryId}
      onClose={onClose}
    >
      {activeCategoryId === 'identity' ? (
        <IdentityCategory
          onRestoreIdentity={() => setRestoringIdentity(true)}
        />
      ) : null}
      {activeCategoryId === 'friends' ? <FriendsCategory /> : null}
      {activeCategoryId === 'sessions' ? (
        <SessionsCategory onOpenSession={setOpenSessionId} />
      ) : null}
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
