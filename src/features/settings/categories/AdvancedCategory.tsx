import { useCallback, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { FolderOpenIcon } from 'lucide-react'
import { toast } from 'sonner'

import { SettingsRow, SettingsSection } from '@/components/SettingsRow'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { useOnboardingState } from '@/features/onboarding'
import { useAutostart } from '@/features/system'
import { useSettingsStore } from '@/stores/settingsStore'

export function AdvancedCategory() {
  const debugLogEnabled = useSettingsStore((s) => s.values.debugLogEnabled)
  const setDebugLogEnabled = useSettingsStore((s) => s.setDebugLogEnabled)
  const autostart = useAutostart()
  const onboarding = useOnboardingState()
  const [openingFolder, setOpeningFolder] = useState(false)
  const [resettingOnboarding, setResettingOnboarding] = useState(false)

  const handleOpenDataFolder = useCallback(async () => {
    setOpeningFolder(true)
    try {
      await invoke<string>('system_open_data_folder')
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Could not open data folder.'
      toast.error(message)
    } finally {
      setOpeningFolder(false)
    }
  }, [])

  const handleReplayOnboarding = useCallback(async () => {
    setResettingOnboarding(true)
    try {
      await onboarding.reset()
      toast.success('Onboarding will play on the next launch.')
    } finally {
      setResettingOnboarding(false)
    }
  }, [onboarding])

  const autostartDisabled =
    autostart.status === 'loading' ||
    autostart.status === 'saving' ||
    autostart.status === 'unavailable'

  return (
    <SettingsSection heading="Advanced">
      <SettingsRow
        label="Launch StudyVis at login"
        help="Off by default. The app stays in the tray to receive invites."
        control={
          <Switch
            checked={autostart.enabled}
            disabled={autostartDisabled}
            onCheckedChange={(checked) =>
              void autostart.toggle(Boolean(checked))
            }
            aria-label="Launch StudyVis at login"
          />
        }
      />
      {autostart.status === 'unavailable' ? (
        <SettingsRow
          label="Autostart unavailable"
          help="No Tauri runtime detected — autostart toggles only work in the packaged app."
        />
      ) : null}
      {autostart.status === 'error' && autostart.error ? (
        <SettingsRow
          label="Autostart error"
          help={autostart.error}
          control={
            <span className="text-xs text-status-alerted">
              {autostart.error}
            </span>
          }
        />
      ) : null}
      <SettingsRow
        label="Debug log"
        help="Logs verbose diagnostic output to the developer console. Off by default; persists across launches."
        control={
          <Switch
            checked={debugLogEnabled}
            onCheckedChange={(checked) =>
              void setDebugLogEnabled(Boolean(checked))
            }
            aria-label="Debug log"
          />
        }
      />
      <SettingsRow
        label="Open data folder"
        help="Reveals the directory holding your local SQLite database and identity record."
        control={
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void handleOpenDataFolder()}
            disabled={openingFolder}
          >
            <FolderOpenIcon /> Open
          </Button>
        }
      />
      <SettingsRow
        label="Replay onboarding"
        help="Restarts the welcome → permissions → tutorial flow from the beginning. Your identity and friends are kept."
        control={
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void handleReplayOnboarding()}
            disabled={resettingOnboarding}
          >
            {resettingOnboarding ? 'Resetting…' : 'Replay'}
          </Button>
        }
      />
    </SettingsSection>
  )
}
