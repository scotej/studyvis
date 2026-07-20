// Settings → About: version (from Vite's __APP_VERSION__ define), a link to
// the GitHub releases page, and the X6 auto-update controls.
//
// The toggle is the zero-outbound guarantee: while it's off, `UpdaterBoot`
// never schedules a check and nothing here calls one either. X4's opt-in tag
// check used to live in this file; the updater subsumed it, so there is one
// update mechanism instead of two overlapping ones.

import { useCallback, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { ExternalLinkIcon, RotateCcwIcon, SearchIcon } from 'lucide-react'
import { toast } from 'sonner'

import { SettingsRow, SettingsSection } from '@/components/SettingsRow'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { useUpdaterStore } from '@/features/updater'
import { useSettingsStore } from '@/stores/settingsStore'
import { strings } from '@/strings'

const COPYRIGHT_LINE = strings.settings.about.copyright.line(
  new Date().getFullYear()
)

export function AboutCategory() {
  const [opening, setOpening] = useState(false)
  const autoUpdateEnabled = useSettingsStore((s) => s.values.autoUpdateEnabled)
  const setAutoUpdateEnabled = useSettingsStore((s) => s.setAutoUpdateEnabled)

  const status = useUpdaterStore((s) => s.status)
  const pendingVersion = useUpdaterStore((s) => s.version)
  const percent = useUpdaterStore((s) => s.percent)
  const installing = useUpdaterStore((s) => s.installing)
  const errorKind = useUpdaterStore((s) => s.errorKind)
  const checkNow = useUpdaterStore((s) => s.checkNow)
  const installAndRestart = useUpdaterStore((s) => s.installAndRestart)

  const copy = strings.settings.about
  const updaterCopy = strings.updater.settings

  const handleRestart = useCallback(async () => {
    const ok = await installAndRestart()
    if (!ok) toast.error(strings.updater.errors.installFailed)
  }, [installAndRestart])

  const handleOpenReleases = useCallback(async () => {
    setOpening(true)
    try {
      await invoke('system_open_releases')
    } catch (err) {
      const message =
        err instanceof Error ? err.message : copy.releases.errorFallback
      toast.error(message)
    } finally {
      setOpening(false)
    }
  }, [copy.releases.errorFallback])

  const openReleasesButton = (
    <Button
      variant="secondary"
      size="sm"
      onClick={() => void handleOpenReleases()}
      disabled={opening}
    >
      <ExternalLinkIcon /> {copy.releases.openCta}
    </Button>
  )

  // One row that changes shape with the updater's state, rather than four
  // rows that are empty most of the time. Rendered only while auto-update is
  // on — with it off there is no state to report and offering "Check now"
  // would contradict the toggle sitting right above it.
  const updateStatusRow = () => {
    if (!autoUpdateEnabled) return null

    if (status === 'ready' && pendingVersion) {
      return (
        <SettingsRow
          label={updaterCopy.readyLabel}
          help={updaterCopy.readyHelp(pendingVersion)}
          control={
            <Button
              size="sm"
              onClick={() => void handleRestart()}
              disabled={installing}
            >
              <RotateCcwIcon /> {updaterCopy.restartCta}
            </Button>
          }
        />
      )
    }

    if (status === 'downloading' && pendingVersion) {
      return (
        <SettingsRow
          label={updaterCopy.downloadingLabel}
          help={updaterCopy.downloadingHelp(
            pendingVersion,
            Math.round(percent)
          )}
        />
      )
    }

    const help =
      status === 'checking'
        ? updaterCopy.checkingHelp
        : errorKind === 'check'
          ? strings.updater.errors.checkFailed
          : errorKind === 'download'
            ? strings.updater.errors.downloadFailed
            : updaterCopy.upToDateHelp(__APP_VERSION__)

    return (
      <SettingsRow
        label={copy.version.label}
        help={help}
        control={
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void checkNow({ userInitiated: true })}
            disabled={status === 'checking'}
          >
            <SearchIcon /> {updaterCopy.checkCta}
          </Button>
        }
      />
    )
  }

  return (
    <SettingsSection heading={copy.heading}>
      <SettingsRow label={copy.app.label} help={copy.app.help} />
      <SettingsRow
        label={copy.version.label}
        control={
          <span className="font-mono text-sm text-text-secondary">
            {__APP_VERSION__}
          </span>
        }
      />
      <SettingsRow label={copy.copyright.label} help={COPYRIGHT_LINE} />
      <SettingsRow
        label={copy.autoUpdate.label}
        help={copy.autoUpdate.help}
        control={
          <Switch
            checked={autoUpdateEnabled}
            onCheckedChange={(checked) =>
              void setAutoUpdateEnabled(Boolean(checked))
            }
            aria-label={copy.autoUpdate.ariaLabel}
          />
        }
      />
      {updateStatusRow()}
      <SettingsRow
        label={copy.releases.label}
        help={copy.releases.help}
        control={openReleasesButton}
      />
    </SettingsSection>
  )
}
