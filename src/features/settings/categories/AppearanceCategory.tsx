import { useState } from 'react'
import { toast } from 'sonner'

import { SettingsRow, SettingsSection } from '@/components/SettingsRow'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Switch } from '@/components/ui/switch'
import { useTheme } from '@/design/theme-context'
import { resetWindowToDefault } from '@/features/system'
import {
  isThemeMode,
  isWindowStyleMode,
  readWindowStyleBootCache,
  useSettingsStore,
  type ThemeMode,
  type WindowStyleMode,
} from '@/stores/settingsStore'
import { strings } from '@/strings'

export function AppearanceCategory() {
  const { mode, setMode } = useTheme()
  const reduceMotion = useSettingsStore((s) => s.values.reduceMotion)
  const setReduceMotion = useSettingsStore((s) => s.setReduceMotion)
  const windowStyle = useSettingsStore((s) => s.values.windowStyle)
  const setWindowStyle = useSettingsStore((s) => s.setWindowStyle)
  const relaunchApp = useSettingsStore((s) => s.relaunchApp)
  const rememberWindowLayout = useSettingsStore(
    (s) => s.values.rememberWindowLayout
  )
  const setRememberWindowLayout = useSettingsStore(
    (s) => s.setRememberWindowLayout
  )
  const clearWindowLayout = useSettingsStore((s) => s.clearWindowLayout)
  const copy = strings.settings.appearance

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

  const handleResetWindow = async () => {
    try {
      await resetWindowToDefault()
      // Forget the tracked geometry too: with remember on, the listener
      // re-captures the fresh default in a beat; with remember off, this
      // clears the leftover so a later re-enable starts clean.
      await clearWindowLayout()
      toast(copy.window.reset.resetToast)
    } catch {
      toast.error(copy.window.reset.resetError)
    }
  }

  return (
    <>
      <SettingsSection heading={copy.heading}>
        <SettingsRow
          label={copy.theme.label}
          help={copy.theme.help}
          stack
          control={
            <RadioGroup
              value={mode}
              onValueChange={handleThemeChange}
              className="grid-flow-col auto-cols-max gap-6"
              aria-label={copy.theme.ariaLabel}
            >
              <div className="flex items-center gap-2">
                <RadioGroupItem value="dark" id="theme-dark" />
                <Label htmlFor="theme-dark">{copy.theme.options.dark}</Label>
              </div>
              <div className="flex items-center gap-2">
                <RadioGroupItem value="light" id="theme-light" />
                <Label htmlFor="theme-light">{copy.theme.options.light}</Label>
              </div>
              <div className="flex items-center gap-2">
                <RadioGroupItem value="auto" id="theme-auto" />
                <Label htmlFor="theme-auto">{copy.theme.options.auto}</Label>
              </div>
            </RadioGroup>
          }
        />
        <SettingsRow
          label={copy.reduceMotion.label}
          help={copy.reduceMotion.help}
          control={
            <Switch
              checked={reduceMotion}
              onCheckedChange={(checked) => void setReduceMotion(checked)}
              aria-label={copy.reduceMotion.ariaLabel}
            />
          }
        />
      </SettingsSection>
      <SettingsSection heading={copy.window.heading}>
        <SettingsRow
          label={copy.windowStyle.label}
          help={
            relaunchPending
              ? copy.windowStyle.helpRelaunchOnly
              : copy.windowStyle.helpRelaunchAndDescribe
          }
          stack
          control={
            // min-h-8 reserves the conditional Relaunch button's height (h-8)
            // so toggling the radios never shifts the rows below; the button
            // sits adjacent to the radios (not far-edge) so cause and effect
            // stay in one eye span.
            <div className="flex min-h-8 items-center gap-6">
              <RadioGroup
                value={windowStyle}
                onValueChange={handleWindowStyleChange}
                className="grid-flow-col auto-cols-max gap-6"
                aria-label={copy.windowStyle.ariaLabel}
              >
                <div className="flex items-center gap-2">
                  <RadioGroupItem value="system" id="window-style-system" />
                  <Label htmlFor="window-style-system">
                    {copy.windowStyle.options.system}
                  </Label>
                </div>
                <div className="flex items-center gap-2">
                  <RadioGroupItem value="custom" id="window-style-custom" />
                  <Label htmlFor="window-style-custom">
                    {copy.windowStyle.options.custom}
                  </Label>
                </div>
              </RadioGroup>
              {relaunchPending ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void relaunchApp()}
                >
                  {copy.windowStyle.relaunchCta}
                </Button>
              ) : null}
            </div>
          }
        />
        <SettingsRow
          label={copy.window.remember.label}
          help={copy.window.remember.help}
          control={
            <Switch
              checked={rememberWindowLayout}
              onCheckedChange={(checked) =>
                void setRememberWindowLayout(checked)
              }
              aria-label={copy.window.remember.ariaLabel}
            />
          }
        />
        <SettingsRow
          label={copy.window.reset.label}
          help={copy.window.reset.help}
          control={
            <Button
              variant="outline"
              size="sm"
              onClick={() => void handleResetWindow()}
              aria-label={copy.window.reset.resetAriaLabel}
            >
              {copy.window.reset.resetCta}
            </Button>
          }
        />
      </SettingsSection>
    </>
  )
}
