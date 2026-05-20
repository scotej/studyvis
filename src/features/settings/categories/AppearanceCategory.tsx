import { useState } from 'react'

import { SettingsRow, SettingsSection } from '@/components/SettingsRow'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Switch } from '@/components/ui/switch'
import { useTheme } from '@/design/theme-context'
import {
  isThemeMode,
  isWindowStyleMode,
  readWindowStyleBootCache,
  useSettingsStore,
  type ThemeMode,
  type WindowStyleMode,
} from '@/stores/settingsStore'

export function AppearanceCategory() {
  const { mode, setMode } = useTheme()
  const reduceMotion = useSettingsStore((s) => s.values.reduceMotion)
  const setReduceMotion = useSettingsStore((s) => s.setReduceMotion)
  const windowStyle = useSettingsStore((s) => s.values.windowStyle)
  const setWindowStyle = useSettingsStore((s) => s.setWindowStyle)
  const relaunchApp = useSettingsStore((s) => s.relaunchApp)

  // The chrome that Rust actually applied this process — frozen at first
  // render. If the user toggles below, `windowStyle` (the saved value)
  // diverges from this until the next launch. We compare against the
  // booted value rather than the saved value so the "Relaunch now"
  // affordance only appears when there's a real pending difference.
  const [bootedWindowStyle] = useState(readWindowStyleBootCache)
  const relaunchPending = windowStyle !== bootedWindowStyle

  const handleThemeChange = (value: string) => {
    if (isThemeMode(value)) setMode(value as ThemeMode)
  }

  const handleWindowStyleChange = (value: string) => {
    if (isWindowStyleMode(value)) void setWindowStyle(value as WindowStyleMode)
  }

  return (
    <SettingsSection heading="Appearance">
      <SettingsRow
        label="Theme"
        help="Switches the entire app immediately."
        stack
        control={
          <RadioGroup
            value={mode}
            onValueChange={handleThemeChange}
            className="grid-cols-1 gap-3 sm:grid-flow-col sm:auto-cols-max sm:gap-6"
            aria-label="Theme"
          >
            <div className="flex items-center gap-2">
              <RadioGroupItem value="dark" id="theme-dark" />
              <Label htmlFor="theme-dark">Dark</Label>
            </div>
            <div className="flex items-center gap-2">
              <RadioGroupItem value="light" id="theme-light" />
              <Label htmlFor="theme-light">Light</Label>
            </div>
            <div className="flex items-center gap-2">
              <RadioGroupItem value="auto" id="theme-auto" />
              <Label htmlFor="theme-auto">Auto (follow system)</Label>
            </div>
          </RadioGroup>
        }
      />
      <SettingsRow
        label="Window style"
        help={
          relaunchPending
            ? 'Applies on next relaunch.'
            : 'Replaces the native title bar with our own. Applies after a relaunch.'
        }
        stack
        control={
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
            <RadioGroup
              value={windowStyle}
              onValueChange={handleWindowStyleChange}
              className="grid-cols-1 gap-3 sm:grid-flow-col sm:auto-cols-max sm:gap-6"
              aria-label="Window style"
            >
              <div className="flex items-center gap-2">
                <RadioGroupItem value="system" id="window-style-system" />
                <Label htmlFor="window-style-system">System</Label>
              </div>
              <div className="flex items-center gap-2">
                <RadioGroupItem value="custom" id="window-style-custom" />
                <Label htmlFor="window-style-custom">Custom</Label>
              </div>
            </RadioGroup>
            {relaunchPending ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => void relaunchApp()}
              >
                Relaunch now
              </Button>
            ) : null}
          </div>
        }
      />
      <SettingsRow
        label="Reduce motion"
        help="Replaces transitions with fades. Fully wired in V3; your choice is saved now."
        control={
          <Switch
            checked={reduceMotion}
            onCheckedChange={(checked) => void setReduceMotion(checked)}
            aria-label="Reduce motion"
          />
        }
      />
    </SettingsSection>
  )
}
