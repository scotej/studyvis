import type { Meta, StoryObj } from '@storybook/react-vite'

import {
  SessionOverlayWindow,
  type SessionOverlayRuntime,
} from '@/features/session/SessionOverlayWindow'
import type { SessionOverlayTone } from '@/features/session/sessionOverlay'

const runtime: SessionOverlayRuntime = {
  listen: async () => () => {},
  emit: async () => {},
  close: async () => {},
}

const meta = {
  title: 'Features/SessionOverlayWindow',
  component: SessionOverlayWindow,
  decorators: [
    (Story) => (
      <div className="w-[420px] bg-bg-base">
        <Story />
      </div>
    ),
  ],
  parameters: { layout: 'centered' },
} satisfies Meta<typeof SessionOverlayWindow>

export default meta
type Story = StoryObj<typeof meta>

function snapshot(tone: SessionOverlayTone, body?: string) {
  return {
    item: {
      id: tone,
      title:
        tone === 'neutral'
          ? 'Notes'
          : tone === 'warning'
            ? 'Heads up, looking off-task.'
            : 'Off task',
      body:
        body ??
        (tone === 'neutral'
          ? 'Sam: I will be back in five minutes.'
          : 'The current screen does not appear related to the study topic.'),
      tone,
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    },
    queued: 0,
  }
}

export const Message: Story = {
  args: { initialSnapshot: snapshot('neutral'), runtime },
}

export const Warning: Story = {
  args: { initialSnapshot: snapshot('warning'), runtime },
}

export const Alert: Story = {
  args: { initialSnapshot: snapshot('alerted'), runtime },
}

export const LongMessage: Story = {
  args: {
    initialSnapshot: snapshot(
      'warning',
      [
        'The current screen does not appear related to the study topic.',
        'This explanation deliberately spans several lines to exercise the same variable-length content that previously overflowed the fixed-height notification window.',
        'The card should grow naturally until its bounded, keyboard-scrollable body region is reached.',
      ].join('\n\n')
    ),
    runtime,
  },
}
