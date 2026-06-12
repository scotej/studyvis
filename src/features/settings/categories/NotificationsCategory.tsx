import { SettingsRow, SettingsSection } from '@/components/SettingsRow'
import { Switch } from '@/components/ui/switch'
import { useSettingsStore } from '@/stores/settingsStore'
import { strings } from '@/strings'

export function NotificationsCategory() {
  const inviteNotify = useSettingsStore(
    (s) => s.values.incomingInviteNotificationEnabled
  )
  const pomodoroNotify = useSettingsStore(
    (s) => s.values.pomodoroNotificationEnabled
  )
  const pomodoroSound = useSettingsStore((s) => s.values.pomodoroSoundEnabled)
  const friendOnlineNotify = useSettingsStore(
    (s) => s.values.friendOnlineNotificationEnabled
  )
  const minimizeToTray = useSettingsStore((s) => s.values.minimizeToTrayOnClose)
  const setInviteNotify = useSettingsStore(
    (s) => s.setIncomingInviteNotificationEnabled
  )
  const setPomodoroNotify = useSettingsStore(
    (s) => s.setPomodoroNotificationEnabled
  )
  const setPomodoroSound = useSettingsStore((s) => s.setPomodoroSoundEnabled)
  const setFriendOnlineNotify = useSettingsStore(
    (s) => s.setFriendOnlineNotificationEnabled
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
        label={copy.pomodoro.label}
        help={copy.pomodoro.help}
        control={
          <Switch
            checked={pomodoroNotify}
            onCheckedChange={(checked) =>
              void setPomodoroNotify(Boolean(checked))
            }
            aria-label={copy.pomodoro.ariaLabel}
          />
        }
      />
      <SettingsRow
        label={copy.pomodoroSound.label}
        help={copy.pomodoroSound.help}
        control={
          <Switch
            checked={pomodoroSound}
            onCheckedChange={(checked) =>
              void setPomodoroSound(Boolean(checked))
            }
            aria-label={copy.pomodoroSound.ariaLabel}
          />
        }
      />
      <SettingsRow
        label={copy.friendOnline.label}
        help={copy.friendOnline.help}
        control={
          <Switch
            checked={friendOnlineNotify}
            onCheckedChange={(checked) =>
              void setFriendOnlineNotify(Boolean(checked))
            }
            aria-label={copy.friendOnline.ariaLabel}
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
