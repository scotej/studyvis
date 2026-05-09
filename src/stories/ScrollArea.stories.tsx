import type { Meta, StoryObj } from '@storybook/react-vite'

import { ScrollArea } from '@/components/ui/scroll-area'

const meta = {
  title: 'UI/ScrollArea',
  component: ScrollArea,
  parameters: { layout: 'centered' },
} satisfies Meta<typeof ScrollArea>

export default meta
type Story = StoryObj<typeof meta>

const items = Array.from({ length: 30 }, (_, i) => `Audit row ${i + 1}`)

export const Default: Story = {
  render: () => (
    <ScrollArea className="h-64 w-72 rounded-md border border-border-default bg-bg-surface p-3">
      <div className="flex flex-col gap-2 text-sm">
        {items.map((s) => (
          <div key={s}>{s}</div>
        ))}
      </div>
    </ScrollArea>
  ),
}
