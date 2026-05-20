import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'

import { SettingsRow, SettingsSection } from '@/components/SettingsRow'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import type { CaptureDisplaysMode } from '@/stores/settingsStore'

// V3-P4 — Standalone story for the Settings → AI "Capture displays" row.
// Rendering it outside AiCategory keeps the story focused on the new control
// (and avoids pulling in the model picker / sidecar wiring that would
// otherwise dominate the AI category page).

type CaptureDisplaysControlProps = {
  value: CaptureDisplaysMode
  onChange: (v: CaptureDisplaysMode) => void
}

function CaptureDisplaysControl({
  value,
  onChange,
}: CaptureDisplaysControlProps) {
  return (
    <SettingsSection heading="AI">
      <SettingsRow
        label="Capture displays"
        stack
        help="All displays sends every monitor to the local AI as one image. Peers never see your screen."
        control={
          <RadioGroup
            value={value}
            onValueChange={(v) => onChange(v as CaptureDisplaysMode)}
            className="grid-cols-1 gap-3 sm:grid-flow-col sm:auto-cols-max sm:gap-6"
            aria-label="Capture displays"
          >
            <div className="flex items-center gap-2">
              <RadioGroupItem
                value="primary"
                id="capture-displays-story-primary"
              />
              <Label htmlFor="capture-displays-story-primary">
                Primary only
              </Label>
            </div>
            <div className="flex items-center gap-2">
              <RadioGroupItem value="all" id="capture-displays-story-all" />
              <Label htmlFor="capture-displays-story-all">All displays</Label>
            </div>
          </RadioGroup>
        }
      />
    </SettingsSection>
  )
}

function StoryHarness({ initial }: { initial: CaptureDisplaysMode }) {
  const [value, setValue] = useState<CaptureDisplaysMode>(initial)
  return <CaptureDisplaysControl value={value} onChange={setValue} />
}

const meta = {
  title: 'Features/AI/CaptureDisplaysControl',
  component: StoryHarness,
  parameters: { layout: 'padded' },
  decorators: [
    (Story) => (
      <div className="mx-auto w-full max-w-2xl rounded-lg border border-border-subtle bg-bg-base px-8 py-8">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof StoryHarness>

export default meta
type Story = StoryObj<typeof meta>

export const PrimaryOnly: Story = {
  args: { initial: 'primary' },
}

export const AllDisplays: Story = {
  args: { initial: 'all' },
}
