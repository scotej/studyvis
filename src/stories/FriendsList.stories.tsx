import type { Meta, StoryObj } from '@storybook/react-vite'

import { FriendsListView } from '@/features/friends/FriendsListView'
import type { Friend } from '@/lib/db/friends'

const NOW = new Date('2026-05-09T12:00:00Z').getTime()
const DAY = 24 * 60 * 60 * 1000

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
    isOnline: () => false,
    onAddFriend: () => {},
    onInvite: () => {},
    now: NOW,
  },
}

export const Populated: Story = {
  args: {
    friends: [ALICE, BO, MEI],
    isOnline: () => true,
    onAddFriend: () => {},
    onInvite: () => {},
    now: NOW,
  },
}

export const MixedOnlineOffline: Story = {
  args: {
    friends: [ALICE, BO, MEI],
    isOnline: (edPubkeyHex) =>
      edPubkeyHex === ALICE.ed_pubkey_hex || edPubkeyHex === BO.ed_pubkey_hex,
    onAddFriend: () => {},
    onInvite: () => {},
    now: NOW,
  },
}

export const SingleOfflineFriend: Story = {
  args: {
    friends: [MEI],
    isOnline: () => false,
    onAddFriend: () => {},
    onInvite: () => {},
    now: NOW,
  },
}
