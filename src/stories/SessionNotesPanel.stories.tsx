import { useEffect, type ReactNode } from 'react'
import type { Decorator, Meta, StoryObj } from '@storybook/react-vite'
import { expect, fn, userEvent, within } from 'storybook/test'

import {
  __resetAiAgentRuntime,
  __setAiAgentRuntime,
  getAiAgentRuntime,
  useModelStore,
} from '@/features/ai'
import { useSessionStore } from '@/stores/sessionStore'
import { useSettingsStore } from '@/stores/settingsStore'

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

function StoryStateBoundary({ children }: { children: ReactNode }) {
  useEffect(() => {
    const previousPeers = useSessionStore.getState().peers
    const previousModelId = useModelStore.getState().activeModelId
    const previousAiEnabled =
      useSettingsStore.getState().values.aiFeaturesEnabled
    const previousAiRuntime = getAiAgentRuntime()

    useSessionStore.setState({ peers: {} })
    useModelStore.setState({ activeModelId: null })
    useSettingsStore.setState((state) => ({
      values: { ...state.values, aiFeaturesEnabled: false },
    }))
    __resetAiAgentRuntime()

    return () => {
      useSessionStore.setState({ peers: previousPeers })
      useModelStore.setState({ activeModelId: previousModelId })
      useSettingsStore.setState((state) => ({
        values: { ...state.values, aiFeaturesEnabled: previousAiEnabled },
      }))
      __setAiAgentRuntime(previousAiRuntime)
    }
  }, [])

  return children
}

const withIsolatedStoryState: Decorator = (Story, context) => (
  <StoryStateBoundary key={context.id}>
    <Story />
  </StoryStateBoundary>
)

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
  decorators: [withIsolatedStoryState],
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

const STORY_PEERS = {
  alicePeer: {
    peerId: 'alicePeer',
    hasStream: true,
    ptt: false,
    edPubkeyHex: '11'.repeat(32),
    displayName: 'Alice',
    joinedAt: NOW,
  },
  blakePeer: {
    peerId: 'blakePeer',
    hasStream: true,
    ptt: false,
    edPubkeyHex: '22'.repeat(32),
    displayName: 'Blake',
    joinedAt: NOW,
  },
}

export const AiConversation: Story = {
  play: async ({ canvasElement }) => {
    useSettingsStore.setState((state) => ({
      values: { ...state.values, aiFeaturesEnabled: true },
    }))
    useModelStore.setState({ activeModelId: 'story-model' })
    __setAiAgentRuntime({
      fetch: async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    reply_text:
                      'You are working through the current study block.',
                  }),
                },
              },
            ],
          }),
          { status: 200 }
        ),
      now: () => NOW,
      getSidecarStatus: async () => ({
        running: true,
        starting: false,
        port: 43123,
        model: '/models/story-model.gguf',
        mmproj: null,
        ctx_size: 4096,
        errored: false,
        last_error: null,
      }),
    })

    const canvas = within(canvasElement)
    await userEvent.click(
      canvas.getByRole('button', { name: 'Add conversation' })
    )
    await userEvent.click(
      within(document.body).getByRole('menuitem', { name: /StudyVis AI/ })
    )
    const input = await canvas.findByRole('textbox', {
      name: 'Message StudyVis AI',
    })
    await userEvent.type(input, 'How am I doing?')
    await userEvent.click(
      canvas.getByRole('button', { name: 'Send message to StudyVis AI' })
    )
    await expect(
      await canvas.findByText(
        'You are working through the current study block.'
      )
    ).toBeVisible()
    await expect(
      canvas.getByRole('tab', { name: 'StudyVis AI' })
    ).toHaveAttribute('aria-selected', 'true')
    await expect(canvas.getByText('You')).toBeVisible()
  },
}

export const DirectMessageSelection: Story = {
  play: async ({ canvasElement }) => {
    useSessionStore.setState({ peers: STORY_PEERS })
    const canvas = within(canvasElement)
    await userEvent.click(
      canvas.getByRole('button', { name: 'Add conversation' })
    )
    await userEvent.click(
      within(document.body).getByRole('menuitem', { name: /Alice/ })
    )
    await expect(canvas.getByText('No direct messages yet.')).toBeVisible()
    await expect(
      await canvas.findByRole('tab', { name: 'Alice' })
    ).toHaveAttribute('aria-selected', 'true')
  },
}

export const DirectMessagesHideWhenSessionReturnsToTwo: Story = {
  play: async ({ canvasElement }) => {
    useSessionStore.setState({ peers: STORY_PEERS })
    const canvas = within(canvasElement)
    await userEvent.click(
      canvas.getByRole('button', { name: 'Add conversation' })
    )
    await userEvent.click(
      within(document.body).getByRole('menuitem', { name: /Alice/ })
    )
    await expect(
      await canvas.findByRole('tab', { name: 'Alice' })
    ).toHaveAttribute('aria-selected', 'true')

    useSessionStore.setState({
      peers: { alicePeer: STORY_PEERS.alicePeer },
    })

    await expect(
      await canvas.findByRole('tab', { name: 'Group' })
    ).toHaveAttribute('aria-selected', 'true')
    await expect(canvas.queryByRole('tab', { name: 'Alice' })).toBeNull()

    await userEvent.click(
      canvas.getByRole('button', { name: 'Add conversation' })
    )
    await expect(
      within(document.body).queryByRole('menuitem', { name: /Alice/ })
    ).toBeNull()
  },
}

export const PeerLeaves: Story = {
  play: async ({ canvasElement }) => {
    useSessionStore.setState({ peers: STORY_PEERS })
    const canvas = within(canvasElement)
    await userEvent.click(
      canvas.getByRole('button', { name: 'Add conversation' })
    )
    await userEvent.click(
      within(document.body).getByRole('menuitem', { name: /Alice/ })
    )
    useSessionStore.setState({ peers: {} })
    await expect(
      await canvas.findByRole('tab', { name: 'Group' })
    ).toHaveAttribute('aria-selected', 'true')
    await expect(canvas.queryByRole('tab', { name: 'Alice' })).toBeNull()
  },
}

export const KeyboardResize: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const separator = canvas.getByRole('separator', {
      name: 'Resize chat area',
    })
    const initial = Number(separator.getAttribute('aria-valuenow'))
    separator.focus()
    await userEvent.keyboard('{ArrowUp}')
    await expect(separator).toHaveAttribute(
      'aria-valuenow',
      String(initial + 24)
    )
  },
}
