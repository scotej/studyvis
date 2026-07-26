import type { Meta, StoryObj } from '@storybook/react-vite'

import { FriendsListView } from '@/features/friends/FriendsListView'
import type { FriendPresenceState } from '@/features/friends/presence'
import type { Friend } from '@/lib/db/friends'

const NOW = new Date('2026-05-09T12:00:00Z').getTime()
const DAY = 24 * 60 * 60 * 1000
const MINUTE = 60 * 1000

const ALICE: Friend = {
  ed_pubkey_hex:
    '11111111111111111111111111111111111111111111111111111111111111aa',
  x_pubkey_hex:
    'aa11111111111111111111111111111111111111111111111111111111111111',
  display_name: 'Alice',
  paired_at: NOW - 30 * DAY,
  last_studied_with: NOW - DAY,
}
const BO: Friend = {
  ed_pubkey_hex:
    '22222222222222222222222222222222222222222222222222222222222222bb',
  x_pubkey_hex:
    'bb22222222222222222222222222222222222222222222222222222222222222',
  display_name: 'Bo',
  paired_at: NOW - 60 * DAY,
  last_studied_with: NOW - 4 * DAY,
}
const MEI: Friend = {
  ed_pubkey_hex:
    '33333333333333333333333333333333333333333333333333333333333333cc',
  x_pubkey_hex:
    'cc33333333333333333333333333333333333333333333333333333333333333',
  display_name: 'Mei',
  paired_at: NOW - 90 * DAY,
  last_studied_with: NOW - 14 * DAY,
}

const ONLINE: FriendPresenceState = { state: 'online', limited: false }
const LIMITED: FriendPresenceState = { state: 'online', limited: true }
const OFFLINE: FriendPresenceState = { state: 'offline', lastSeenAt: null }

function presenceOf(
  states: Record<string, FriendPresenceState>
): (edPubkeyHex: string) => FriendPresenceState {
  return (edPubkeyHex) => states[edPubkeyHex] ?? OFFLINE
}

const meta = {
  title: 'Features/FriendsList',
  component: FriendsListView,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof FriendsListView>

export default meta
type Story = StoryObj<typeof meta>

export const Empty: Story = {
  args: {
    friends: [],
    presenceOf: () => OFFLINE,
    onAddFriend: () => {},
    onInvite: () => {},
    now: NOW,
  },
}

export const Populated: Story = {
  args: {
    friends: [ALICE, BO, MEI],
    presenceOf: () => ONLINE,
    onAddFriend: () => {},
    onInvite: () => {},
    now: NOW,
  },
}

export const MixedOnlineOffline: Story = {
  args: {
    friends: [ALICE, BO, MEI],
    presenceOf: presenceOf({
      [ALICE.ed_pubkey_hex]: ONLINE,
      [BO.ed_pubkey_hex]: ONLINE,
    }),
    onAddFriend: () => {},
    onInvite: () => {},
    now: NOW,
  },
}

// I74 — Bo is reachable over the relay but no direct connection is forming:
// amber dot, "limited connection" label, and the one-line hint with the
// Settings → Network deep link above the list.
export const LimitedConnection: Story = {
  args: {
    friends: [ALICE, BO, MEI],
    presenceOf: presenceOf({
      [ALICE.ed_pubkey_hex]: ONLINE,
      [BO.ed_pubkey_hex]: LIMITED,
      [MEI.ed_pubkey_hex]: { state: 'offline', lastSeenAt: NOW - 12 * MINUTE },
    }),
    onAddFriend: () => {},
    onInvite: () => {},
    onOpenNetworkSettings: () => {},
    now: NOW,
  },
}

// I74 — offline recency: Alice was seen moments ago (clean goodbye), Bo
// within the hour, Mei beyond a day (falls back to the plain label).
export const OfflineRecency: Story = {
  args: {
    friends: [ALICE, BO, MEI],
    presenceOf: presenceOf({
      [ALICE.ed_pubkey_hex]: { state: 'offline', lastSeenAt: NOW - MINUTE },
      [BO.ed_pubkey_hex]: { state: 'offline', lastSeenAt: NOW - 45 * MINUTE },
      [MEI.ed_pubkey_hex]: { state: 'offline', lastSeenAt: NOW - 2 * DAY },
    }),
    onAddFriend: () => {},
    onInvite: () => {},
    now: NOW,
  },
}

export const SingleOfflineFriend: Story = {
  args: {
    friends: [MEI],
    presenceOf: () => OFFLINE,
    onAddFriend: () => {},
    onInvite: () => {},
    now: NOW,
  },
}
