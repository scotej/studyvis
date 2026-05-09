import type { Meta, StoryObj } from '@storybook/react-vite'

import { IdentitySetup } from '@/features/identity/IdentitySetup'
import { Toaster } from '@/components/ui/sonner'

const MOCK_MNEMONIC = [
  'ocean',
  'ladder',
  'cinnamon',
  'trumpet',
  'cobalt',
  'hammock',
  'pine',
  'mirror',
  'quartz',
  'fountain',
  'pencil',
  'bridge',
  'mosaic',
  'thistle',
  'rumor',
  'saffron',
  'lantern',
  'pebble',
  'vapor',
  'oasis',
  'cipher',
  'maple',
  'garnet',
  'horizon',
]

const meta = {
  title: 'Features/IdentitySetup',
  component: IdentitySetup,
  parameters: { layout: 'fullscreen' },
  args: {
    mnemonic: MOCK_MNEMONIC,
    onConfirm: () => {
      // story-only no-op
    },
  },
  decorators: [
    (Story) => (
      <>
        <Story />
        <Toaster position="bottom-right" />
      </>
    ),
  ],
} satisfies Meta<typeof IdentitySetup>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
