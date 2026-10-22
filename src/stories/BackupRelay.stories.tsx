import type { Meta, StoryObj } from '@storybook/react-vite'
import { fn } from 'storybook/test'

import { BackupRelayView } from '@/features/settings/categories/BackupRelayRow'
import type { ManagedTurnSnapshot } from '@/lib/managedTurn'

const snapshot: ManagedTurnSnapshot = {
  identityEdPubkeyHex: 'a'.repeat(64),
  status: 'signed-out',
  providers: { github: true, google: true },
  accounts: [],
  approved: false,
  relayEnabled: true,
  freeOnlyConfirmed: true,
  login: null,
  pendingAccount: null,
  error: null,
}
const account = {
  provider: 'github' as const,
  subject: '12345',
  label: 'study-friend',
  approved: false,
}
const meta = {
  title: 'Features/Settings/Backup relay',
  component: BackupRelayView,
  parameters: { layout: 'padded' },
  decorators: [
    (Story) => (
      <div className="mx-auto max-w-3xl">
        <Story />
      </div>
    ),
  ],
  args: {
    snapshot,
    enabled: true,
    hasIdentity: true,
    preference: 'auto',
    onEnable: fn(),
    onLogin: fn(),
    onConfirm: fn(),
    onCancel: fn(),
    onRefresh: fn(),
    onUnlink: fn(),
  },
} satisfies Meta<typeof BackupRelayView>
export default meta
type Story = StoryObj<typeof meta>

export const Off: Story = { args: { enabled: false } }
export const SignIn: Story = {}
export const WaitingForBrowser: Story = {
  args: {
    snapshot: {
      ...snapshot,
      status: 'pending',
      login: {
        transactionId: 'test',
        url: 'https://example.invalid/',
        expiresAt: 1,
      },
    },
  },
}
export const ConfirmAccount: Story = {
  args: {
    snapshot: { ...snapshot, status: 'confirm', pendingAccount: account },
  },
}
export const WaitingForApproval: Story = {
  args: { snapshot: { ...snapshot, status: 'linked', accounts: [account] } },
}
export const Approved: Story = {
  args: {
    snapshot: {
      ...snapshot,
      status: 'linked',
      approved: true,
      accounts: [{ ...account, approved: true }],
    },
  },
}
export const FreeOnlyDisabled: Story = {
  args: {
    snapshot: { ...snapshot, relayEnabled: false, freeOnlyConfirmed: false },
  },
}
export const NeverUseTurn: Story = {
  ...Approved,
  args: { ...Approved.args, preference: 'never' },
}
export const Unavailable: Story = {
  args: {
    snapshot: {
      ...snapshot,
      providers: { github: false, google: false },
      status: 'unavailable',
    },
  },
}
export const Failed: Story = { args: { failed: true } }
export const DifferentProfile: Story = {
  args: { snapshot: { ...snapshot, status: 'error', error: 'conflict' } },
}
