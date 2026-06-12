import type { Meta, StoryObj } from '@storybook/react-vite'

import { RelayDiagnostics } from '@/components/RelayDiagnostics'
import type { RelayRow } from '@/lib/relayDiagnostics'

// F2 — the connection-diagnostics panel. Stories pass a fixed `rows` set so
// the panel is fully controlled (no trystero polling) — each story is a frozen
// snapshot of one relay-health state.

const meta = {
  title: 'Features/Settings/RelayDiagnostics',
  component: RelayDiagnostics,
  parameters: { layout: 'padded' },
  decorators: [
    (Story) => (
      <div className="mx-auto w-full max-w-md rounded-lg border border-border-subtle bg-bg-surface p-6">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof RelayDiagnostics>

export default meta
type Story = StoryObj<typeof meta>

const ALL_CONNECTED: RelayRow[] = [
  { url: 'wss://nos.lol', status: 'connected' },
  { url: 'wss://relay.primal.net', status: 'connected' },
  { url: 'wss://relay.snort.social', status: 'connected' },
]

const MIXED: RelayRow[] = [
  { url: 'wss://nos.lol', status: 'connected' },
  { url: 'wss://offchain.pub', status: 'connecting' },
  { url: 'wss://purplerelay.com', status: 'down' },
]

const ALL_DOWN: RelayRow[] = [
  { url: 'wss://nos.lol', status: 'down' },
  { url: 'wss://relay.primal.net', status: 'down' },
]

export const AllConnected: Story = {
  args: { rows: ALL_CONNECTED },
}

export const Mixed: Story = {
  args: { rows: MIXED },
}

export const AllDown: Story = {
  args: { rows: ALL_DOWN },
}

export const Empty: Story = {
  args: { rows: [] },
}
