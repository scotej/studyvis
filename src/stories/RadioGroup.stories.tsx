import type { Meta, StoryObj } from '@storybook/react-vite'

import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'

const meta = {
  title: 'UI/RadioGroup',
  component: RadioGroup,
  parameters: { layout: 'centered' },
} satisfies Meta<typeof RadioGroup>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  render: () => (
    <RadioGroup defaultValue="dark" aria-label="Theme" className="gap-3">
      <div className="flex items-center gap-2">
        <RadioGroupItem value="dark" id="rg-dark" />
        <Label htmlFor="rg-dark">Dark</Label>
      </div>
      <div className="flex items-center gap-2">
        <RadioGroupItem value="light" id="rg-light" />
        <Label htmlFor="rg-light">Light</Label>
      </div>
      <div className="flex items-center gap-2">
        <RadioGroupItem value="auto" id="rg-auto" />
        <Label htmlFor="rg-auto">Auto</Label>
      </div>
    </RadioGroup>
  ),
}

export const Inline: Story = {
  render: () => (
    <RadioGroup
      defaultValue="auto"
      aria-label="TURN preference"
      className="grid-flow-col auto-cols-min gap-6"
    >
      <div className="flex items-center gap-2">
        <RadioGroupItem value="auto" id="rg-i-auto" />
        <Label htmlFor="rg-i-auto">Auto</Label>
      </div>
      <div className="flex items-center gap-2">
        <RadioGroupItem value="always" id="rg-i-always" />
        <Label htmlFor="rg-i-always">Always</Label>
      </div>
      <div className="flex items-center gap-2">
        <RadioGroupItem value="never" id="rg-i-never" />
        <Label htmlFor="rg-i-never">Never</Label>
      </div>
    </RadioGroup>
  ),
}

export const Disabled: Story = {
  render: () => (
    <RadioGroup defaultValue="a" aria-label="Disabled" className="gap-2">
      <div className="flex items-center gap-2">
        <RadioGroupItem value="a" id="rg-d-a" disabled />
        <Label htmlFor="rg-d-a">Option A</Label>
      </div>
      <div className="flex items-center gap-2">
        <RadioGroupItem value="b" id="rg-d-b" disabled />
        <Label htmlFor="rg-d-b">Option B</Label>
      </div>
    </RadioGroup>
  ),
}
