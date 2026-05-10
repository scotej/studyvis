import { SettingsRow, SettingsSection } from '@/components/SettingsRow'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { isMacLikePlatform } from '@/lib/utils'

export function ShortcutsCategory() {
  const mod = isMacLikePlatform() ? '⌘' : 'Ctrl'

  return (
    <SettingsSection heading="Shortcuts">
      <SettingsRow
        label="Push to talk · friends"
        help="Hold to unmute your microphone for everyone in the session."
        control={
          <span className="flex items-center gap-1">
            <Kbd>{mod}</Kbd>
            <Kbd>[</Kbd>
          </span>
        }
      />
      <SettingsRow
        label="Talk to AI"
        help="Reserved for V2 — opens the AI focus dialog."
        control={
          <span className="flex items-center gap-1">
            <Kbd>{mod}</Kbd>
            <Kbd>]</Kbd>
          </span>
        }
      />
      <SettingsRow
        label="Custom keybindings"
        help="The rebind UI lands in V3. Until then, the bindings above are fixed."
        disabled
        control={
          <Button variant="secondary" size="sm" disabled aria-disabled="true">
            Coming soon
          </Button>
        }
      />
    </SettingsSection>
  )
}
