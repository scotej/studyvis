import type { Meta, StoryObj } from '@storybook/react-vite'

import { AuditLogPanel, type AuditLogEntry } from '@/components/AuditLogPanel'

const NOW = 1_700_000_000_000

const POPULATED: AuditLogEntry[] = [
  { seq: 1, name: 'You', description: 'joined', ts: NOW - 12 * 60_000 },
  { seq: 2, name: 'Alice', description: 'joined', ts: NOW - 11 * 60_000 },
  { seq: 3, name: 'Bo', description: 'joined', ts: NOW - 8 * 60_000 },
  {
    seq: 4,
    name: 'You',
    description: 'started a Pomodoro',
    ts: NOW - 6 * 60_000,
  },
  {
    seq: 5,
    name: 'You',
    description: 'got a self-warning',
    ts: NOW - 4 * 60_000,
    hoverDetail: 'Eyes drifting away from the editor for several seconds.',
  },
  {
    seq: 6,
    name: 'Alice',
    description: 'looking off-task',
    ts: NOW - 3 * 60_000,
    hoverDetail: 'Visible YouTube tab unrelated to the declared topic.',
  },
  { seq: 7, name: 'Bo', description: 'took a break', ts: NOW - 60_000 },
  { seq: 8, name: 'Bo', description: 'returned', ts: NOW - 5_000 },
]

// The Populated set sits right at the 480px frame's boundary and never
// scrolls, so axe's `scrollable-region-focusable` rule has nothing to assert
// on. Twenty rows overflow it and keep the scroller's tab stop honest.
const OVERFLOWING: AuditLogEntry[] = Array.from({ length: 20 }, (_, i) => ({
  seq: i + 1,
  name: ['You', 'Alice', 'Bo'][i % 3],
  description: i % 2 === 0 ? 'took a break' : 'returned',
  ts: NOW - (20 - i) * 60_000,
}))

const meta = {
  title: 'Components/AuditLogPanel',
  component: AuditLogPanel,
  parameters: { layout: 'fullscreen' },
  args: { events: [], now: NOW },
} satisfies Meta<typeof AuditLogPanel>

export default meta
type Story = StoryObj<typeof meta>

export const Empty: Story = {
  render: () => (
    <div style={{ height: 480 }} className="flex bg-bg-base">
      <div className="flex-1" />
      <AuditLogPanel events={[]} now={NOW} />
    </div>
  ),
}

export const Populated: Story = {
  render: () => (
    <div style={{ height: 480 }} className="flex bg-bg-base">
      <div className="flex-1" />
      <AuditLogPanel events={POPULATED} now={NOW} />
    </div>
  ),
}

// Long enough to actually scroll — the keyboard-reachability case.
export const Overflowing: Story = {
  render: () => (
    <div style={{ height: 480 }} className="flex bg-bg-base">
      <div className="flex-1" />
      <AuditLogPanel events={OVERFLOWING} now={NOW} />
    </div>
  ),
}
