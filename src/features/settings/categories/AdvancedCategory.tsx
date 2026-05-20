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
import { strings } from '@/strings'

export function AdvancedCategory() {
  const debugLogEnabled = useSettingsStore((s) => s.values.debugLogEnabled)
  const setDebugLogEnabled = useSettingsStore((s) => s.setDebugLogEnabled)
  const autostart = useAutostart()
  const onboarding = useOnboardingState()
  const [openingFolder, setOpeningFolder] = useState(false)
  const [resettingOnboarding, setResettingOnboarding] = useState(false)
  const copy = strings.settings.advanced

  const handleOpenDataFolder = useCallback(async () => {
    setOpeningFolder(true)
    try {
      await invoke<string>('system_open_data_folder')
    } catch (err) {
      const message =
        err instanceof Error ? err.message : copy.dataFolder.errorFallback
      toast.error(message)
    } finally {
      setOpeningFolder(false)
    }
  }, [copy.dataFolder.errorFallback])

  const handleReplayOnboarding = useCallback(async () => {
    setResettingOnboarding(true)
    try {
      await onboarding.reset()
      toast.success(copy.replayOnboarding.scheduledToast)
    } finally {
      setResettingOnboarding(false)
    }
  }, [onboarding, copy.replayOnboarding.scheduledToast])

  const autostartDisabled =
    autostart.status === 'loading' ||
    autostart.status === 'saving' ||
    autostart.status === 'unavailable'

  return (
    <SettingsSection heading={copy.heading}>
      <SettingsRow
        label={copy.autostart.label}
        help={copy.autostart.help}
        control={
          <Switch
            checked={autostart.enabled}
            disabled={autostartDisabled}
            onCheckedChange={(checked) =>
              void autostart.toggle(Boolean(checked))
            }
            aria-label={copy.autostart.ariaLabel}
          />
        }
      />
      {autostart.status === 'unavailable' ? (
        <SettingsRow
          label={copy.autostartUnavailable.label}
          help={copy.autostartUnavailable.help}
        />
      ) : null}
      {autostart.status === 'error' && autostart.error ? (
        <SettingsRow
          label={copy.autostartError.label}
          help={autostart.error}
          control={
            <span className="text-xs text-status-alerted">
              {autostart.error}
            </span>
          }
        />
      ) : null}
      <SettingsRow
        label={copy.debugLog.label}
        help={copy.debugLog.help}
        control={
          <Switch
            checked={debugLogEnabled}
            onCheckedChange={(checked) =>
              void setDebugLogEnabled(Boolean(checked))
            }
            aria-label={copy.debugLog.ariaLabel}
          />
        }
      />
      <SettingsRow
        label={copy.dataFolder.label}
        help={copy.dataFolder.help}
        control={
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void handleOpenDataFolder()}
            disabled={openingFolder}
          >
            <FolderOpenIcon /> {copy.dataFolder.openCta}
          </Button>
        }
      />
      <SettingsRow
        label={copy.replayOnboarding.label}
        help={copy.replayOnboarding.help}
        control={
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void handleReplayOnboarding()}
            disabled={resettingOnboarding}
            aria-disabled={resettingOnboarding ? true : undefined}
          >
            {copy.replayOnboarding.replayCta}
          </Button>
        }
      />
    </SettingsSection>
  )
}
