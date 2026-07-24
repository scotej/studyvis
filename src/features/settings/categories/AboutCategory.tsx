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
import { useSessionStore } from '@/stores/sessionStore'
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
  const sessionActive = useSessionStore((s) => s.status === 'active')

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
      {/* Trailing glyph: the external-link arrow annotates where the action
          leads, so it follows the label ("Open ↗") like every other
          leaves-the-app affordance. */}
      {copy.releases.openCta} <ExternalLinkIcon />
    </Button>
  )

  // One row that changes shape with the updater's state, rather than four
  // rows that are empty most of the time.
  const updateStatusRow = () => {
    // The "ready" row is shown regardless of the toggle: once bytes are
    // downloaded and signature-verified they're local and installable, and
    // hiding the restart here while the Home banner still offers it would let
    // the two surfaces disagree. The toggle governs *future* checks, not an
    // update already staged. (Turning it off mid-download is covered too:
    // that download finishes and lands here as "ready".)
    if (status === 'ready' && pendingVersion) {
      return (
        <SettingsRow
          label={updaterCopy.readyLabel}
          help={
            sessionActive
              ? updaterCopy.lockedDuringSession(pendingVersion)
              : updaterCopy.readyHelp(pendingVersion)
          }
          control={
            <Button
              size="sm"
              onClick={() => void handleRestart()}
              disabled={installing || sessionActive}
            >
              <RotateCcwIcon /> {updaterCopy.restartCta}
            </Button>
          }
        />
      )
    }

    // Below here is live-check status. With auto-update off there's nothing to
    // report and offering "Check now" would contradict the toggle above it.
    if (!autoUpdateEnabled) return null

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

    const help = sessionActive
      ? updaterCopy.checkLockedDuringSession
      : status === 'checking'
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
            disabled={status === 'checking' || sessionActive}
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
      {/* Value in the control slot to match the Version row above — two
          read-only fact rows shouldn't place their values at opposite
          edges. */}
      <SettingsRow
        label={copy.copyright.label}
        control={
          <span className="text-sm text-text-secondary">{COPYRIGHT_LINE}</span>
        }
      />
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
