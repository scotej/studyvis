import type { Meta, StoryObj } from '@storybook/react-vite'

import { IdentityLoadErrorView } from '@/features/identity/IdentityLoadErrorView'

const noop = () => undefined

const meta = {
  title: 'Features/Identity/LoadError',
  component: IdentityLoadErrorView,
  parameters: { layout: 'fullscreen' },
  args: {
    retrying: false,
    onRetry: noop,
    onRecover: noop,
  },
} satisfies Meta<typeof IdentityLoadErrorView>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const Retrying: Story = {
  args: { retrying: true },
}

// #47 E1 — identity.json parsed but the keychain holds no keys: the 24-word
// restore is the primary action (retrying can't fix an empty keychain).
export const KeysMissing: Story = {
  args: { variant: 'keysMissing' },
}
