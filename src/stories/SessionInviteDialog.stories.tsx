import type { Meta, StoryObj } from '@storybook/react-vite'

import { SessionInviteDialog } from '@/features/session'
import type { Friend } from '@/lib/db/friends'

// #47 A2 — the mid-session online-friends picker (host only). Pure view:
// friends/presence/session state are injected as props.

function friend(seed: string, name: string | null): Friend {
  return {
    ed_pubkey_hex: seed.repeat(64).slice(0, 64),
    x_pubkey_hex: seed.repeat(64).slice(0, 64),
    display_name: name,
    paired_at: 1_700_000_000_000,
    last_studied_with: null,
  }
}

const FRIENDS: Friend[] = [
  friend('a', 'Alex'),
  friend('b', 'Blake'),
  friend('c', null),
  friend('d', 'Devin (offline)'),
]

const meta = {
  title: 'Session/SessionInviteDialog',
  component: SessionInviteDialog,
  args: {
    open: true,
    onOpenChange: () => {},
    onInvite: () => {},
    friends: FRIENDS,
    // Devin is offline; everyone else is online.
    isOnline: (ed: string) => !ed.startsWith('d'),
    inSessionEdPubkeys: new Set<string>(),
    full: false,
  },
} satisfies Meta<typeof SessionInviteDialog>

export default meta
type Story = StoryObj<typeof meta>

// Three online friends (one with the display-name fallback); Devin filtered
// out as offline.
export const OnlineFriends: Story = {}

// Blake is already in the session — only the remaining online friends show.
export const FiltersFriendsAlreadyInSession: Story = {
  args: {
    inSessionEdPubkeys: new Set([FRIENDS[1].ed_pubkey_hex]),
  },
}

// Nobody online: calm empty state, no spinner (DESIGN-SYSTEM §10).
export const NoFriendsOnline: Story = {
  args: {
    isOnline: () => false,
  },
}

// The live remote-peer count hit the 4-user cap — the picker explains
// instead of offering invites the host cap would reject.
export const SessionFull: Story = {
  args: {
    full: true,
  },
}
