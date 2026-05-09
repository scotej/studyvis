import type { Meta, StoryObj } from '@storybook/react-vite'

import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet'

const meta = {
  title: 'UI/Sheet',
  component: Sheet,
  parameters: { layout: 'centered' },
} satisfies Meta<typeof Sheet>

export default meta
type Story = StoryObj<typeof meta>

const sides = ['top', 'right', 'bottom', 'left'] as const

export const Right: Story = {
  render: () => (
    <Sheet>
      <SheetTrigger asChild>
        <Button>Open sheet</Button>
      </SheetTrigger>
      <SheetContent side="right">
        <SheetHeader>
          <SheetTitle>Settings</SheetTitle>
          <SheetDescription>Adjust app preferences.</SheetDescription>
        </SheetHeader>
        <SheetFooter />
      </SheetContent>
    </Sheet>
  ),
}

export const AllSides: Story = {
  render: () => (
    <div className="flex flex-wrap gap-3">
      {sides.map((side) => (
        <Sheet key={side}>
          <SheetTrigger asChild>
            <Button variant="outline" size="sm">
              {side}
            </Button>
          </SheetTrigger>
          <SheetContent side={side}>
            <SheetHeader>
              <SheetTitle>{side}</SheetTitle>
              <SheetDescription>Sheet from {side}.</SheetDescription>
            </SheetHeader>
          </SheetContent>
        </Sheet>
      ))}
    </div>
  ),
}
