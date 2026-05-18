import { SettingsRow, SettingsSection } from '@/components/SettingsRow'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import {
  isTurnPreference,
  useSettingsStore,
  type TurnPreference,
} from '@/stores/settingsStore'

export function NetworkCategory() {
  const turn = useSettingsStore((s) => s.values.turnPreference)
  const setTurn = useSettingsStore((s) => s.setTurnPreference)

  return (
    <SettingsSection heading="Network">
      <SettingsRow
        label="About TURN"
        help="StudyVis connects you to friends directly when it can. Some networks (corporate firewalls, strict NATs) block that, so a relay server passes the traffic along instead. It's still encrypted end-to-end; the relay only ever sees encrypted bytes."
      />
      <SettingsRow
        label="TURN preference"
        help="Auto is recommended. Always-on burns more bandwidth on the public relay but can stabilize choppy connections. Never disables relay fallback entirely; sessions may fail to connect on strict networks."
        stack
        control={
          <RadioGroup
            value={turn}
            onValueChange={(value) => {
              if (isTurnPreference(value)) {
                void setTurn(value as TurnPreference)
              }
            }}
            aria-label="TURN preference"
            className="gap-3"
          >
            <div className="flex items-center gap-2">
              <RadioGroupItem value="auto" id="turn-auto" />
              <Label htmlFor="turn-auto">
                Auto (fall back when direct fails)
              </Label>
            </div>
            <div className="flex items-center gap-2">
              <RadioGroupItem value="always" id="turn-always" />
              <Label htmlFor="turn-always">Always on</Label>
            </div>
            <div className="flex items-center gap-2">
              <RadioGroupItem value="never" id="turn-never" />
              <Label htmlFor="turn-never">Never</Label>
            </div>
          </RadioGroup>
        }
      />
    </SettingsSection>
  )
}
