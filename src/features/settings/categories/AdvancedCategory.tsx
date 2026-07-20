// Settings → Advanced: autostart toggle, diagnostics (reveal llama-server
// log, copy version/OS/log-path to clipboard — nothing uploads), open the
// data folder, replay onboarding, and clear-all-session-history behind a
// confirm dialog. Everything here rides Tauri `invoke`; outside the desktop
// runtime the rows render but the actions fail into toasts.

import { useCallback, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import {
  CopyIcon,
  FileTextIcon,
  FolderOpenIcon,
  RotateCcwIcon,
  Trash2Icon,
} from 'lucide-react'
import { toast } from 'sonner'

import { SettingsRow, SettingsSection } from '@/components/SettingsRow'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Switch } from '@/components/ui/switch'
import { useOnboardingState } from '@/features/onboarding'
import { useAutostart } from '@/features/system'
import { sessionsClearAll } from '@/lib/db/sessions'
import { useSettingsStore } from '@/stores/settingsStore'
import { strings } from '@/strings'

export function AdvancedCategory() {
  const debugLogEnabled = useSettingsStore((s) => s.values.debugLogEnabled)
  const setDebugLogEnabled = useSettingsStore((s) => s.setDebugLogEnabled)
  const autostart = useAutostart()
  const onboarding = useOnboardingState()
  const [openingFolder, setOpeningFolder] = useState(false)
  const [sharingLog, setSharingLog] = useState(false)
  const [resettingOnboarding, setResettingOnboarding] = useState(false)
  const [confirmingClear, setConfirmingClear] = useState(false)
  const [clearingHistory, setClearingHistory] = useState(false)
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

  const handleCopyDiagnostics = useCallback(async () => {
    setSharingLog(true)
    try {
      const info = await invoke<{ os: string; arch: string; log_path: string }>(
        'diagnostics_info'
      )
      const text = copy.shareLog.summary({
        version: __APP_VERSION__,
        os: info.os,
        arch: info.arch,
        logPath: info.log_path,
      })
      await navigator.clipboard.writeText(text)
      toast.success(copy.shareLog.copiedToast)
    } catch {
      toast.error(copy.shareLog.copyError)
    } finally {
      setSharingLog(false)
    }
  }, [copy.shareLog])

  const handleRevealLog = useCallback(async () => {
    try {
      await invoke('diagnostics_reveal_log')
    } catch (err) {
      const message =
        err instanceof Error ? err.message : copy.shareLog.revealError
      toast.error(message)
    }
  }, [copy.shareLog.revealError])

  const handleReplayOnboarding = useCallback(async () => {
    setResettingOnboarding(true)
    try {
      await onboarding.reset()
      toast.success(copy.replayOnboarding.scheduledToast)
    } finally {
      setResettingOnboarding(false)
    }
  }, [onboarding, copy.replayOnboarding.scheduledToast])

  const handleClearHistory = useCallback(async () => {
    setClearingHistory(true)
    try {
      await sessionsClearAll()
      // Stats / Sessions / Report all read SQLite on mount, so the wipe flows
      // through the next time any of them opens — nothing in-memory to evict.
      toast.success(copy.clearHistory.clearedToast)
      setConfirmingClear(false)
    } catch (err) {
      const message =
        err instanceof Error ? err.message : copy.clearHistory.errorFallback
      toast.error(message)
    } finally {
      setClearingHistory(false)
    }
  }, [copy.clearHistory])

  const autostartDisabled =
    autostart.status === 'loading' ||
    autostart.status === 'saving' ||
    autostart.status === 'unavailable'

  return (
    <>
      <SettingsSection heading={copy.heading}>
        <SettingsRow
          label={copy.autostart.label}
          // One row per setting: when autostart is unavailable the note
          // replaces this row's help instead of appearing as a separate
          // control-less pseudo-row below it.
          help={
            autostart.status === 'unavailable'
              ? copy.autostartUnavailable.help
              : copy.autostart.help
          }
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
        {autostart.status === 'error' && autostart.error ? (
          // help, not the control slot: help wraps in the min-w-0 column,
          // while the shrink-0 control slot would let a long backend error
          // force the row wide. The status color marks it as an error, the
          // row label carries the same information without color.
          <SettingsRow
            label={copy.autostartError.label}
            help={
              <span className="text-status-alerted">{autostart.error}</span>
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
          label={copy.shareLog.label}
          help={copy.shareLog.help}
          control={
            <div className="flex gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void handleCopyDiagnostics()}
                disabled={sharingLog}
              >
                <CopyIcon /> {copy.shareLog.copyCta}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void handleRevealLog()}
              >
                <FileTextIcon /> {copy.shareLog.revealCta}
              </Button>
            </div>
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
              <RotateCcwIcon /> {copy.replayOnboarding.replayCta}
            </Button>
          }
        />
        <SettingsRow
          label={copy.clearHistory.label}
          help={copy.clearHistory.help}
          control={
            <Button
              type="button"
              variant="destructive"
              size="sm"
              onClick={() => setConfirmingClear(true)}
            >
              <Trash2Icon /> {copy.clearHistory.clearCta}
            </Button>
          }
        />
      </SettingsSection>

      <Dialog
        open={confirmingClear}
        onOpenChange={(open) => {
          if (!open) setConfirmingClear(false)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{copy.clearHistory.confirmTitle}</DialogTitle>
            <DialogDescription>
              {copy.clearHistory.confirmBody}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setConfirmingClear(false)}
              disabled={clearingHistory}
            >
              {copy.clearHistory.cancelCta}
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => void handleClearHistory()}
              disabled={clearingHistory}
              aria-disabled={clearingHistory}
            >
              {copy.clearHistory.confirmCta}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
