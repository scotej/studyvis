import { SettingsRow, SettingsSection } from '@/components/SettingsRow'
import { Switch } from '@/components/ui/switch'
import { useSettingsStore } from '@/stores/settingsStore'

export function NotificationsCategory() {
  const inviteNotify = useSettingsStore(
    (s) => s.values.incomingInviteNotificationEnabled
  )
  const minimizeToTray = useSettingsStore((s) => s.values.minimizeToTrayOnClose)
  const setInviteNotify = useSettingsStore(
    (s) => s.setIncomingInviteNotificationEnabled
  )
  const setMinimizeToTray = useSettingsStore((s) => s.setMinimizeToTrayOnClose)

  return (
    <SettingsSection heading="Notifications">
      <SettingsRow
        label="Incoming invite notifications"
        help="OS-level prompt when a friend invites you to study. The in-app toast always fires."
        control={
          <Switch
            checked={inviteNotify}
            onCheckedChange={(checked) =>
              void setInviteNotify(Boolean(checked))
            }
            aria-label="Incoming invite notifications"
          />
        }
      />
      <SettingsRow
        label="Minimize to tray on close"
        help="When on, closing the window keeps StudyVis in the tray so friends can still reach you. When off, closing exits the app."
        control={
          <Switch
            checked={minimizeToTray}
            onCheckedChange={(checked) =>
              void setMinimizeToTray(Boolean(checked))
            }
            aria-label="Minimize to tray on close"
          />
        }
      />
    </SettingsSection>
  )
}
