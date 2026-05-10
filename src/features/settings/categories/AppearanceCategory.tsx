import { SettingsRow, SettingsSection } from '@/components/SettingsRow'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Switch } from '@/components/ui/switch'
import { useTheme } from '@/design/theme-context'
import {
  isThemeMode,
  useSettingsStore,
  type ThemeMode,
} from '@/stores/settingsStore'

export function AppearanceCategory() {
  const { mode, setMode } = useTheme()
  const reduceMotion = useSettingsStore((s) => s.values.reduceMotion)
  const setReduceMotion = useSettingsStore((s) => s.setReduceMotion)

  const handleThemeChange = (value: string) => {
    if (isThemeMode(value)) setMode(value as ThemeMode)
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
            className="grid-flow-col auto-cols-min gap-6"
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
        label="Reduce motion"
        help="Replaces transitions with fades. Wired in V3 — the toggle persists today."
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
