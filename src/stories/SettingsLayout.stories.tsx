import { useState, type CSSProperties } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import {
  BellIcon,
  ChartLineIcon,
  GlobeIcon,
  HistoryIcon,
  InfoIcon,
  KeyboardIcon,
  PaletteIcon,
  SlidersHorizontalIcon,
  SparklesIcon,
  UserRoundIcon,
  UsersIcon,
} from 'lucide-react'

import {
  SettingsLayout,
  type SettingsCategoryDescriptor,
} from '@/components/SettingsLayout'
import { SettingsRow, SettingsSection } from '@/components/SettingsRow'
import { Switch } from '@/components/ui/switch'
import { strings } from '@/strings'

type CategoryId =
  | 'identity'
  | 'friends'
  | 'sessions'
  | 'stats'
  | 'ai'
  | 'appearance'
  | 'notifications'
  | 'shortcuts'
  | 'network'
  | 'advanced'
  | 'about'

function navIcon(Icon: typeof UserRoundIcon) {
  return (
    <Icon size={16} strokeWidth={1.5} aria-hidden="true" className="shrink-0" />
  )
}

// Mirrors the shipped list in src/features/settings/Settings.tsx — all
// eleven categories with the same labels, icons, and grouping, so the story
// represents the real rail height (the 640px-minimum fit contract below
// depends on it).
const nav = strings.settings.nav
const groups = strings.settings.navGroups
const CATEGORIES: ReadonlyArray<SettingsCategoryDescriptor<CategoryId>> = [
  {
    id: 'identity',
    label: nav.identity,
    icon: navIcon(UserRoundIcon),
    group: groups.you,
  },
  {
    id: 'friends',
    label: nav.friends,
    icon: navIcon(UsersIcon),
    group: groups.you,
  },
  {
    id: 'sessions',
    label: nav.sessions,
    icon: navIcon(HistoryIcon),
    group: groups.study,
  },
  {
    id: 'stats',
    label: nav.stats,
    icon: navIcon(ChartLineIcon),
    group: groups.study,
  },
  { id: 'ai', label: nav.ai, icon: navIcon(SparklesIcon), group: groups.study },
  {
    id: 'appearance',
    label: nav.appearance,
    icon: navIcon(PaletteIcon),
    group: groups.app,
  },
  {
    id: 'notifications',
    label: nav.notifications,
    icon: navIcon(BellIcon),
    group: groups.app,
  },
  {
    id: 'shortcuts',
    label: nav.shortcuts,
    icon: navIcon(KeyboardIcon),
    group: groups.app,
  },
  {
    id: 'network',
    label: nav.network,
    icon: navIcon(GlobeIcon),
    group: groups.system,
  },
  {
    id: 'advanced',
    label: nav.advanced,
    icon: navIcon(SlidersHorizontalIcon),
    group: groups.system,
  },
  {
    id: 'about',
    label: nav.about,
    icon: navIcon(InfoIcon),
    group: groups.system,
  },
]

const meta = {
  title: 'Components/SettingsLayout',
  parameters: { layout: 'fullscreen' },
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

function DemoPane({ active }: { active: CategoryId }) {
  return (
    <SettingsSection heading={strings.settings.nav[active]}>
      <SettingsRow
        label="Reduce motion"
        help="Replaces transitions with fades."
        control={<Switch />}
      />
    </SettingsSection>
  )
}

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
        <DemoPane active={active} />
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
        <DemoPane active={active} />
      </SettingsLayout>
    )
  },
}

// The fit contract at the window minimum (DESIGN-SYSTEM §12: 1024×640): all
// eleven grouped nav items must be visible without the rail scrolling, with
// the fluid rail pinned to its 1024-window value. The pin matters because
// --settings-rail-width uses 22vw, which resolves against the Storybook
// preview viewport, not this frame — without the override any canvas wider
// than ~1272px would render the rail at its 280px maximum. 14rem = 224px =
// the clamp floor (22vw of 1024 is within 1px of it).
export const MinimumWindow: Story = {
  render: () => {
    const [active, setActive] = useState<CategoryId>('appearance')
    return (
      <div
        className="overflow-hidden border border-border-default"
        style={
          {
            width: 1024,
            height: 640,
            '--settings-rail-width': '14rem',
          } as CSSProperties
        }
      >
        <SettingsLayout
          categories={CATEGORIES}
          activeCategoryId={active}
          onCategorySelect={(id) => setActive(id as CategoryId)}
          onClose={() => {}}
        >
          <DemoPane active={active} />
        </SettingsLayout>
      </div>
    )
  },
}
