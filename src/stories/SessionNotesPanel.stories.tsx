import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, fn, userEvent, within } from 'storybook/test'

import { SessionNotesPanel } from '@/features/session/SessionNotesPanel'
import type { SessionImage, SessionNote } from '@/features/session/notesStore'

// #47 B6 — the quiet in-session text strip (pure view; wire + store live in
// SessionView / notes.ts).

const NOW = 1_700_000_000_000
const IMAGE_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg=='
const IMAGE_BYTES = Uint8Array.from(
  atob(IMAGE_DATA_URL.split(',')[1]),
  (character) => character.charCodeAt(0)
)

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

const image: SessionImage = {
  id: 'alice:image:1',
  fromEdPubkeyHex: 'alice',
  mine: false,
  blob: new Blob([IMAGE_BYTES], { type: 'image/png' }),
  objectUrl: IMAGE_DATA_URL,
  filename: 'linear-algebra-notes.png',
  mimeType: 'image/png',
  width: 1,
  height: 1,
  frameCount: 1,
  ts: NOW + 1,
}

const meta = {
  title: 'Session/SessionNotesPanel',
  component: SessionNotesPanel,
  args: {
    onSend: () => {},
    onSendImage: () => {},
    onOpenImage: () => {},
    resolveName: (item: SessionNote | SessionImage) =>
      item.mine ? 'You' : (NAMES[item.fromEdPubkeyHex] ?? 'Peer'),
    images: [],
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

export const WithImage: Story = {
  args: {
    images: [image],
    notes: [],
    onOpenImage: fn(),
  },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(
      canvas.getByRole('button', { name: 'Open image from Alice' })
    )
    await expect(args.onOpenImage).toHaveBeenCalledWith(image)
  },
}

// Fresh session: the empty state explains the feature and its ephemerality.
export const Empty: Story = {
  args: { notes: [] },
}

// Past the 180px list cap, so the scroller actually scrolls — the case
// axe's `scrollable-region-focusable` rule needs to see, and the one where
// the list's own tab stop earns its keep.
export const Overflowing: Story = {
  args: {
    notes: Array.from({ length: 12 }, (_, i) =>
      note(
        i + 1,
        i % 2 === 0 ? 'alice' : 'me',
        i % 2 !== 0,
        `checkpoint ${i + 1}`
      )
    ),
  },
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
