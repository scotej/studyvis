import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'

import { BipBackupPanel } from '@/components/BipBackupPanel'
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
  title: 'Components/BipBackupPanel',
  component: BipBackupPanel,
  parameters: { layout: 'padded' },
  args: { mnemonic: MOCK_MNEMONIC },
  decorators: [
    (Story) => (
      <div className="mx-auto max-w-xl">
        <Story />
        <Toaster position="bottom-right" />
      </div>
    ),
  ],
} satisfies Meta<typeof BipBackupPanel>

export default meta
type Story = StoryObj<typeof meta>

export const ReadOnly: Story = {}

export const WithConfirm: Story = {
  render: (args) => {
    function Demo() {
      const [acknowledged, setAcknowledged] = useState(false)
      return (
        <BipBackupPanel
          mnemonic={args.mnemonic}
          confirm={{
            checked: acknowledged,
            onCheckedChange: setAcknowledged,
          }}
        />
      )
    }
    return <Demo />
  },
}
