import { SettingsRow, SettingsSection } from '@/components/SettingsRow'
import { Switch } from '@/components/ui/switch'
import { useSettingsStore } from '@/stores/settingsStore'
import { strings } from '@/strings'

export function NotificationsCategory() {
  const inviteNotify = useSettingsStore(
    (s) => s.values.incomingInviteNotificationEnabled
  )
  const minimizeToTray = useSettingsStore((s) => s.values.minimizeToTrayOnClose)
  const setInviteNotify = useSettingsStore(
    (s) => s.setIncomingInviteNotificationEnabled
  )
  const setMinimizeToTray = useSettingsStore((s) => s.setMinimizeToTrayOnClose)
  const copy = strings.settings.notifications

  return (
    <SettingsSection heading={copy.heading}>
      <SettingsRow
        label={copy.invites.label}
        help={copy.invites.help}
        control={
          <Switch
            checked={inviteNotify}
            onCheckedChange={(checked) =>
              void setInviteNotify(Boolean(checked))
            }
            aria-label={copy.invites.ariaLabel}
          />
        }
      />
      <SettingsRow
        label={copy.tray.label}
        help={copy.tray.help}
        control={
          <Switch
            checked={minimizeToTray}
            onCheckedChange={(checked) =>
              void setMinimizeToTray(Boolean(checked))
            }
            aria-label={copy.tray.ariaLabel}
          />
        }
      />
    </SettingsSection>
  )
}
