import type { Meta, StoryObj } from '@storybook/react-vite'

import { AuditLogRow } from '@/components/AuditLogRow'

const NOW = 1_700_000_000_000

const meta = {
  title: 'Components/AuditLogRow',
  component: AuditLogRow,
  parameters: { layout: 'padded' },
  args: {
    name: 'Alice',
    description: 'joined',
    ts: NOW - 7_000,
    now: NOW,
  },
} satisfies Meta<typeof AuditLogRow>

export default meta
type Story = StoryObj<typeof meta>

export const Joined: Story = {}

export const Left: Story = { args: { description: 'left', ts: NOW - 32_000 } }

export const TookABreak: Story = {
  args: { description: 'took a break', ts: NOW - 4 * 60_000 },
}

export const StartedPomodoro: Story = {
  args: { description: 'started a Pomodoro', ts: NOW - 1_000 },
}

export const Stack: Story = {
  render: () => (
    <ul
      className="m-0 list-none p-0"
      style={{ width: 320, background: 'var(--bg-surface)' }}
    >
      <AuditLogRow
        name="You"
        description="joined"
        ts={NOW - 60_000}
        now={NOW}
      />
      <AuditLogRow
        name="Alice"
        description="joined"
        ts={NOW - 40_000}
        now={NOW}
      />
      <AuditLogRow name="Bo" description="joined" ts={NOW - 20_000} now={NOW} />
      <AuditLogRow
        name="Alice"
        description="took a break"
        ts={NOW - 5_000}
        now={NOW}
      />
      <AuditLogRow
        name="Alice"
        description="returned"
        ts={NOW - 1_000}
        now={NOW}
      />
    </ul>
  ),
}
