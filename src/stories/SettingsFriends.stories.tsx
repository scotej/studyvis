import type { Meta, StoryObj } from '@storybook/react-vite'

import type { FriendPresenceState } from '@/features/friends'
import {
  FriendsCategoryView,
  type FriendDetail,
} from '@/features/settings/categories/FriendsCategoryView'
import type { Friend } from '@/lib/db/friends'

// The live FriendsCategory in SettingsCategories.stories renders the empty
// state outside Tauri (no friends store, no session history). These fixtures
// are what actually exercise the detail panel — and what the axe-core gate
// audits, which is why one story ships with a panel already expanded.

const NOW = new Date('2026-05-09T12:00:00Z').getTime()
const DAY = 24 * 60 * 60 * 1000
const MINUTE = 60 * 1000

const ALICE: Friend = {
  ed_pubkey_hex:
    '11111111111111111111111111111111111111111111111111111111111111aa',
  x_pubkey_hex:
    'aa11111111111111111111111111111111111111111111111111111111111111',
  display_name: 'Alice',
  paired_at: NOW - 120 * DAY,
  last_studied_with: NOW - DAY,
}
const BO: Friend = {
  ed_pubkey_hex:
    '22222222222222222222222222222222222222222222222222222222222222bb',
  x_pubkey_hex:
    'bb22222222222222222222222222222222222222222222222222222222222222',
  display_name: 'Bo',
  paired_at: NOW - 30 * DAY,
  last_studied_with: NOW - 9 * DAY,
}
// No display name and never paired through a card that carried one — the row
// falls back to the short fingerprint everywhere a name would go.
const NAMELESS: Friend = {
  ed_pubkey_hex:
    '33333333333333333333333333333333333333333333333333333333333333cc',
  x_pubkey_hex:
    'cc33333333333333333333333333333333333333333333333333333333333333',
  display_name: null,
  paired_at: null,
  last_studied_with: null,
}

const ONLINE: FriendPresenceState = { state: 'online', limited: false }
const LIMITED: FriendPresenceState = { state: 'online', limited: true }
const SEEN_RECENTLY: FriendPresenceState = {
  state: 'offline',
  lastSeenAt: NOW - 12 * MINUTE,
}

const DETAILS: FriendDetail[] = [
  {
    friend: ALICE,
    presence: ONLINE,
    safetyNumber: '48213 90271 33518 07642',
    study: { sessions: 27, minutes: 1385, lastAt: NOW - DAY },
  },
  {
    friend: BO,
    presence: LIMITED,
    safetyNumber: '10945 22087 61330 49517',
    study: { sessions: 4, minutes: 95, lastAt: NOW - 9 * DAY },
  },
  {
    friend: NAMELESS,
    presence: SEEN_RECENTLY,
    safetyNumber: '77201 45903 18866 20134',
    study: { sessions: 0, minutes: 0, lastAt: null },
  },
]

const meta = {
  title: 'Features/Settings/Friends',
  component: FriendsCategoryView,
  parameters: { layout: 'padded' },
  args: { now: NOW, onRemove: () => {} },
  decorators: [
    (Story) => (
      <div className="mx-auto w-full max-w-3xl rounded-lg border border-border-subtle bg-bg-base px-8 py-8">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof FriendsCategoryView>

export default meta
type Story = StoryObj<typeof meta>

export const Empty: Story = {
  args: { details: [], studyStatus: 'ready' },
}

export const Collapsed: Story = {
  args: { details: DETAILS, studyStatus: 'ready' },
}

export const Expanded: Story = {
  args: {
    details: DETAILS,
    studyStatus: 'ready',
    defaultExpanded: ALICE.ed_pubkey_hex,
  },
}

// A friend the pane has never seen study together, opened. Also the nameless
// row, so the fingerprint fallback is visible in both the label and the
// buttons' accessible names.
export const ExpandedNoHistory: Story = {
  args: {
    details: DETAILS,
    studyStatus: 'ready',
    defaultExpanded: NAMELESS.ed_pubkey_hex,
  },
}

// No presence subscription behind the pane: the Status row is dropped rather
// than claiming "Offline" on no evidence.
export const NoPresence: Story = {
  args: {
    details: DETAILS.map((d) => ({ ...d, presence: null })),
    studyStatus: 'ready',
    defaultExpanded: ALICE.ed_pubkey_hex,
  },
}

export const StudyHistoryLoading: Story = {
  args: {
    details: DETAILS,
    studyStatus: 'loading',
    defaultExpanded: ALICE.ed_pubkey_hex,
  },
}

export const StudyHistoryError: Story = {
  args: {
    details: DETAILS,
    studyStatus: 'error',
    defaultExpanded: ALICE.ed_pubkey_hex,
  },
}

// Identity still loading, so no safety number can be computed yet.
export const SafetyNumberPending: Story = {
  args: {
    details: DETAILS.map((d) => ({ ...d, safetyNumber: null })),
    studyStatus: 'ready',
    defaultExpanded: ALICE.ed_pubkey_hex,
  },
}
