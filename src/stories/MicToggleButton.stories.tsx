import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'

import { MicToggleButton } from '@/components/MicToggleButton'

const meta = {
  title: 'Components/MicToggleButton',
  component: MicToggleButton,
  args: { enabled: false, onToggle: () => {}, shortcutLabel: '⌘\\' },
} satisfies Meta<typeof MicToggleButton>
export default meta
type Story = StoryObj<typeof meta>

export const PushToTalk: Story = {}
export const AlwaysOn: Story = { args: { enabled: true } }
export const BrowserCompanion: Story = { args: { disabled: true } }
export const Interactive: Story = {
  render: function Interactive(args) {
    const [enabled, setEnabled] = useState(false)
    return (
      <MicToggleButton
        {...args}
        enabled={enabled}
        onToggle={() => setEnabled((value) => !value)}
      />
    )
  },
}
