import type { Meta, StoryObj } from '@storybook/react-vite'

import { tokens } from '@/design/tokens'
import { PendingInvitesView } from '@/features/friends'
import type { PendingInviteEntry } from '@/features/friends'

// #47 B1 — persistent pending-invite rows on the main view (pure view;
// store + expiry wiring live in the PendingInvites container).

const NOW = 1_700_000_000_000

function entry(
  seed: string,
  name: string | null,
  msLeft: number
): PendingInviteEntry {
  return {
    key: `${seed}:topic-${seed}`,
    receivedAt: NOW - 30_000,
    invite: {
      from_ed_pubkey: seed.repeat(64).slice(0, 64),
      payload: {
        session_topic: `topic-${seed}`,
        session_password: 'pw',
        our_display_name: name ?? '',
        expires_at: NOW + msLeft,
        sig: '',
      },
    },
  }
}

const meta = {
  title: 'Friends/PendingInvites',
  component: PendingInvitesView,
  args: {
    now: NOW,
    onAccept: () => {},
    onDismiss: () => {},
    entries: [entry('a', 'Alex', 4 * 60_000), entry('b', null, 90_000)],
  },
} satisfies Meta<typeof PendingInvitesView>

export default meta
type Story = StoryObj<typeof meta>

// Two pending invites: a named sender with minutes left and a fallback-named
// sender about to expire.
export const TwoPending: Story = {}

export const SingleInvite: Story = {
  args: {
    entries: [entry('a', 'Alex', 3 * 60_000)],
  },
}

// Production cap: the list itself scrolls instead of pushing the Settings or
// Report surface beyond the app's 640px minimum window height.
export const MaxCapacity: Story = {
  args: {
    entries: Array.from({ length: 16 }, (_, index) =>
      entry(
        index.toString(16),
        `Study partner ${index + 1}`,
        (index + 1) * 15_000
      )
    ),
  },
  decorators: [
    (Story) => (
      <div
        className="overflow-hidden bg-bg-base text-text-primary"
        style={{ height: tokens.sizes.windowMinHeight }}
      >
        <Story />
      </div>
    ),
  ],
}

// Renders nothing — the section only exists while invites are pending.
export const Empty: Story = {
  args: { entries: [] },
}
