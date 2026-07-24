import type { Meta, StoryObj } from '@storybook/react-vite'

import { RecoverView } from '@/features/identity/RecoverView'

const PROGRESS = { current: 3, total: 6 }

const noop = () => undefined

const meta = {
  title: 'Features/Recover',
  component: RecoverView,
  parameters: { layout: 'fullscreen' },
  args: {
    progress: PROGRESS,
    phase: 'input',
    value: '',
    wordCount: 0,
    error: null,
    identityExists: false,
    onChange: noop,
    onSubmit: noop,
    onBack: noop,
    onConfirmOverwrite: noop,
    onCancelOverwrite: noop,
    onDone: noop,
  },
} satisfies Meta<typeof RecoverView>

export default meta
type Story = StoryObj<typeof meta>

export const Entry: Story = {}

export const Incomplete: Story = {
  args: { error: 'empty' },
}

export const WrongWordCount: Story = {
  args: {
    value: 'ocean ladder cinnamon trumpet cobalt hammock',
    wordCount: 6,
    error: 'short',
  },
}

export const InvalidChecksum: Story = {
  args: {
    value: new Array(24).fill('abandon').join(' '),
    wordCount: 24,
    error: 'invalid',
  },
}

export const UnknownWord: Story = {
  args: {
    value: new Array(23).fill('abandon').concat('cactas').join(' '),
    wordCount: 24,
    error: 'invalid',
    unknownWords: ['cactas'],
  },
}

export const Submitting: Story = {
  args: {
    value: new Array(24).fill('abandon').join(' '),
    wordCount: 24,
    phase: 'submitting',
  },
}

export const ConfirmOverwrite: Story = {
  args: {
    phase: 'confirm',
    identityExists: true,
  },
}

// D5 — escalated confirm shown when the typed words are a DIFFERENT identity
// than the one already on this device.
export const ConfirmDifferentIdentity: Story = {
  args: {
    phase: 'confirm',
    identityExists: true,
    confirmDifferent: true,
  },
}

export const Restored: Story = {
  args: { phase: 'done' },
}
