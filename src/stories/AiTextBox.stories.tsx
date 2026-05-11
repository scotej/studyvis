import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'

import { AiTextBox } from '@/components/AiTextBox'

function Harness({ pending = false }: { pending?: boolean }) {
  const [value, setValue] = useState('')
  return (
    <div className="w-96 p-6">
      <AiTextBox
        value={value}
        onChange={setValue}
        onSubmit={() => alert(`submit: ${value}`)}
        pending={pending}
      />
    </div>
  )
}

const meta = {
  title: 'Components/AiTextBox',
  component: Harness,
  parameters: { layout: 'centered' },
} satisfies Meta<typeof Harness>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const Pending: Story = {
  args: { pending: true },
}
