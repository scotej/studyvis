import type { Meta, StoryObj } from '@storybook/react-vite'

import { SettingsRow, SettingsSection } from '@/components/SettingsRow'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Switch } from '@/components/ui/switch'

const meta = {
  title: 'Components/SettingsRow',
  parameters: { layout: 'padded' },
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

export const SwitchRow: Story = {
  render: () => (
    <div className="mx-auto w-full max-w-2xl">
      <SettingsSection heading="Notifications">
        <SettingsRow
          label="Incoming invite notifications"
          help="OS-level prompt when a friend invites you to study."
          control={<Switch defaultChecked />}
        />
        <SettingsRow
          label="Minimize to tray on close"
          help="Closing the window keeps StudyVis running in the tray."
          control={<Switch defaultChecked />}
        />
      </SettingsSection>
    </div>
  ),
}

export const RadioGroupRow: Story = {
  render: () => (
    <div className="mx-auto w-full max-w-2xl">
      <SettingsSection heading="Appearance">
        <SettingsRow
          label="Theme"
          help="Switches the entire app immediately."
          stack
          control={
            <RadioGroup
              defaultValue="dark"
              className="grid-flow-col auto-cols-min gap-6"
              aria-label="Theme"
            >
              <div className="flex items-center gap-2">
                <RadioGroupItem value="dark" id="story-theme-dark" />
                <Label htmlFor="story-theme-dark">Dark</Label>
              </div>
              <div className="flex items-center gap-2">
                <RadioGroupItem value="light" id="story-theme-light" />
                <Label htmlFor="story-theme-light">Light</Label>
              </div>
              <div className="flex items-center gap-2">
                <RadioGroupItem value="auto" id="story-theme-auto" />
                <Label htmlFor="story-theme-auto">Auto (follow system)</Label>
              </div>
            </RadioGroup>
          }
        />
      </SettingsSection>
    </div>
  ),
}

export const Disabled: Story = {
  render: () => (
    <div className="mx-auto w-full max-w-2xl">
      <SettingsSection heading="Identity">
        <SettingsRow
          label="Show backup mnemonic"
          help="Available in V3 — keep your original 24-word backup safe."
          disabled
          control={
            <Button variant="secondary" size="sm" disabled>
              Show 24 words
            </Button>
          }
        />
      </SettingsSection>
    </div>
  ),
}

export const ShortcutDisplay: Story = {
  render: () => (
    <div className="mx-auto w-full max-w-2xl">
      <SettingsSection heading="Shortcuts">
        <SettingsRow
          label="Push to talk · friends"
          help="Hold to unmute your microphone for everyone in the session."
          control={
            <span className="flex items-center gap-1">
              <Kbd>⌘</Kbd>
              <Kbd>[</Kbd>
            </span>
          }
        />
      </SettingsSection>
    </div>
  ),
}
