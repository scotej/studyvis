import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import {
  isPermissionGranted,
  requestPermission,
} from '@tauri-apps/plugin-notification'
import { toast } from 'sonner'

import { SettingsRow, SettingsSection } from '@/components/SettingsRow'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { useSettingsStore } from '@/stores/settingsStore'
import { strings } from '@/strings'

// #47 B7 — OS-level permission status. All three send paths silently drop
// notifications when the system permission is denied and macOS never
// re-prompts after a hard denial, so toggles could look ON but never fire
// with no diagnosis surface. 'unavailable' (no Tauri bridge — Storybook,
// vite dev) hides the row entirely: there is no OS permission to show.
type SystemPermission = 'checking' | 'granted' | 'denied' | 'unavailable'

function SystemPermissionRow() {
  const copy = strings.settings.notifications.systemPermission
  const [permission, setPermission] = useState<SystemPermission>('checking')

  useEffect(() => {
    let cancelled = false
    isPermissionGranted().then(
      (granted) => {
        if (!cancelled) setPermission(granted ? 'granted' : 'denied')
      },
      () => {
        if (!cancelled) setPermission('unavailable')
      }
    )
    return () => {
      cancelled = true
    }
  }, [])

  if (permission === 'unavailable') return null
  if (permission === 'checking') {
    // Matches the granted row's silhouette exactly — h-4 = the text-xs
    // help line box, h-5 = the text-sm badge — so on the common path
    // (permission already granted) resolving the async read shifts
    // nothing. The denied outcome is taller (stacked buttons); that
    // first-run transition still moves the rows below, which is
    // unavoidable without predicting the answer.
    return (
      <SettingsRow
        label={copy.label}
        help={<Skeleton className="h-4 w-48 max-w-full" />}
        control={
          <div role="status" aria-label={copy.checkingAriaLabel}>
            <Skeleton className="h-5 w-16" />
          </div>
        }
      />
    )
  }

  const handleRequest = () => {
    void (async () => {
      try {
        const result = await requestPermission()
        if (result === 'granted') {
          setPermission('granted')
          return
        }
        // A hard OS denial never re-prompts; steer to the system pane.
        toast.error(copy.stillDenied)
      } catch {
        toast.error(copy.stillDenied)
      }
    })()
  }

  const handleOpenSettings = () => {
    void invoke('system_open_notification_settings').catch(() => {
      toast.error(copy.openErrorFallback)
    })
  }

  if (permission === 'granted') {
    return (
      <SettingsRow
        label={copy.label}
        help={copy.grantedHelp}
        control={
          <span className="text-sm text-text-secondary">
            {copy.grantedBadge}
          </span>
        }
      />
    )
  }

  return (
    <SettingsRow
      label={copy.label}
      help={copy.deniedHelp}
      stack
      control={
        <span className="flex items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleOpenSettings}
          >
            {copy.openSettingsCta}
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={handleRequest}
          >
            {copy.requestCta}
          </Button>
        </span>
      }
    />
  )
}

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
      <SystemPermissionRow />
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
