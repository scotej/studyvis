import type { Meta, StoryObj } from '@storybook/react-vite'

import { SessionNotesPanel } from '@/features/session/SessionNotesPanel'
import type { SessionNote } from '@/features/session/notesStore'

// #47 B6 — the quiet in-session text strip (pure view; wire + store live in
// SessionView / notes.ts).

const NOW = 1_700_000_000_000

function note(
  seq: number,
  from: string,
  mine: boolean,
  text: string
): SessionNote {
  return {
    id: `${from}:${NOW + seq}:${seq}`,
    fromEdPubkeyHex: from,
    mine,
    text,
    ts: NOW + seq,
  }
}

const NAMES: Record<string, string> = { alice: 'Alice', blake: 'Blake' }

const meta = {
  title: 'Session/SessionNotesPanel',
  component: SessionNotesPanel,
  args: {
    onSend: () => {},
    resolveName: (n: SessionNote) =>
      n.mine ? 'You' : (NAMES[n.fromEdPubkeyHex] ?? 'Peer'),
    notes: [
      note(1, 'alice', false, 'brb 5'),
      note(2, 'me', true, 'np, grinding through problem 4'),
      note(3, 'blake', false, 'https://example.com/lecture-notes.pdf'),
      note(4, 'alice', false, 'back'),
    ],
  },
} satisfies Meta<typeof SessionNotesPanel>

export default meta
type Story = StoryObj<typeof meta>

export const Conversation: Story = {}

// Fresh session: the empty state explains the feature and its ephemerality.
export const Empty: Story = {
  args: { notes: [] },
}

// A long note wraps instead of breaking the fixed-width rail.
export const LongNote: Story = {
  args: {
    notes: [
      note(
        1,
        'blake',
        false,
        'heads up — I moved our shared doc to a new folder, the old link will stop working after today. New one is pinned in the usual place. Also going quiet for a deep-focus block until :45.'
      ),
    ],
  },
}
