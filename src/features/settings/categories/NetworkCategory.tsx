import { SettingsRow, SettingsSection } from '@/components/SettingsRow'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import {
  isTurnPreference,
  useSettingsStore,
  type TurnPreference,
} from '@/stores/settingsStore'
import { strings } from '@/strings'

export function NetworkCategory() {
  const turn = useSettingsStore((s) => s.values.turnPreference)
  const setTurn = useSettingsStore((s) => s.setTurnPreference)
  const copy = strings.settings.network

  return (
    <SettingsSection heading={copy.heading}>
      <SettingsRow label={copy.about.label} help={copy.about.help} />
      <SettingsRow
        label={copy.preference.label}
        help={copy.preference.help}
        stack
        control={
          <RadioGroup
            value={turn}
            onValueChange={(value) => {
              if (isTurnPreference(value)) {
                void setTurn(value as TurnPreference)
              }
            }}
            aria-label={copy.preference.ariaLabel}
            className="gap-3"
          >
            <div className="flex items-center gap-2">
              <RadioGroupItem value="auto" id="turn-auto" />
              <Label htmlFor="turn-auto">{copy.preference.options.auto}</Label>
            </div>
            <div className="flex items-center gap-2">
              <RadioGroupItem value="always" id="turn-always" />
              <Label htmlFor="turn-always">
                {copy.preference.options.always}
              </Label>
            </div>
            <div className="flex items-center gap-2">
              <RadioGroupItem value="never" id="turn-never" />
              <Label htmlFor="turn-never">
                {copy.preference.options.never}
              </Label>
            </div>
          </RadioGroup>
        }
      />
    </SettingsSection>
  )
}
