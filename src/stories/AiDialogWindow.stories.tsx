import type { Meta, StoryObj } from '@storybook/react-vite'

import { AiDialogWindow, type AiDialogRuntime } from '@/features/ai'
import type { AgentReply } from '@/features/ai'

const noopRuntime: AiDialogRuntime = {
  listen: async () => () => {},
  emit: async () => {},
  close: async () => {},
  now: () => Date.now(),
}

const context = {
  declaredTopic: 'Studying',
  modelId: 'ggml-org/Qwen2.5-VL-3B-Instruct-GGUF',
  recentAuditKinds: ['joined', 'pomodoro_start'],
}

const meta = {
  title: 'Features/AiDialogWindow',
  component: AiDialogWindow,
  parameters: { layout: 'fullscreen' },
  args: {
    initialContext: context,
    runtime: noopRuntime,
  },
} satisfies Meta<typeof AiDialogWindow>

export default meta
type Story = StoryObj<typeof meta>

export const Idle: Story = {}

export const Typing: Story = {
  args: {
    forceState: {
      text: '5 minute water break',
      pending: false,
      response: null,
    },
  },
}

export const Response: Story = {
  args: {
    forceState: {
      text: '',
      pending: false,
      response: {
        text: "You're 28 min in. A short break sounds reasonable.",
        tone: 'neutral',
      },
    },
  },
}

export const BreakApproved: Story = {
  args: {
    forceState: {
      text: '',
      pending: false,
      response: {
        text: 'Approved · 5 min. Resume when the timer hits zero.',
        tone: 'approved',
      },
    },
  },
}

export const BreakDenied: Story = {
  args: {
    forceState: {
      text: '',
      pending: false,
      response: {
        text: 'Your last break was less than 25 minutes ago — try again in 18 min.',
        tone: 'denied',
      },
    },
  },
}

// Drives the live submit path with a canned agent reply so the story
// demonstrates the request → response transition without needing a
// sidecar. Click Enter (or the form-submit) inside the story to see it.
export const LiveTopicChange: Story = {
  args: {
    handle: async (): Promise<AgentReply> => ({
      intent: 'topic_change',
      payload: { new_topic: 'Coding' },
      reply_text: 'Topic updated to Coding.',
    }),
  },
}
