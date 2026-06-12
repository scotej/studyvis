import { useCallback, useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { ExternalLinkIcon } from 'lucide-react'
import { toast } from 'sonner'

import { SettingsRow, SettingsSection } from '@/components/SettingsRow'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { isNewerVersion } from '@/lib/version'
import { useSettingsStore } from '@/stores/settingsStore'
import { strings } from '@/strings'

const COPYRIGHT_LINE = strings.settings.about.copyright.line(
  new Date().getFullYear()
)

export function AboutCategory() {
  const [opening, setOpening] = useState(false)
  // X4 — the latest release tag when a NEWER version is found, else null.
  // Stays null on every failure (silent) and while the toggle is off.
  const [latestNewer, setLatestNewer] = useState<string | null>(null)
  const versionCheckEnabled = useSettingsStore(
    (s) => s.values.versionCheckEnabled
  )
  const setVersionCheckEnabled = useSettingsStore(
    (s) => s.setVersionCheckEnabled
  )
  const copy = strings.settings.about

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

  // X4 — opt-in version check. ZERO outbound while the toggle is off: the
  // effect bails before any invoke. When on, it runs once per mount (the
  // simpler honest option than a daily timer — the user has to open this
  // screen anyway, and it's the natural place to see the result). Silent on
  // every failure path. The latest tag is compared semver-ishly to the
  // baked-in __APP_VERSION__; only a strictly-newer tag surfaces a row.
  useEffect(() => {
    // ZERO outbound while off: bail before any invoke. A stale `latestNewer`
    // from a prior on-session is harmless — the row's render is gated on
    // `versionCheckEnabled` too, so nothing shows while off.
    if (!versionCheckEnabled) return
    let cancelled = false
    void (async () => {
      try {
        const latest = await invoke<string>('system_fetch_latest_version')
        if (cancelled) return
        setLatestNewer(isNewerVersion(__APP_VERSION__, latest) ? latest : null)
      } catch {
        // Best-effort: a network failure, blocked request, or unparseable
        // tag all leave the row hidden. No toast, no log surfaced to the user.
        if (!cancelled) setLatestNewer(null)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [versionCheckEnabled])

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
        label={copy.versionCheck.label}
        help={copy.versionCheck.help}
        control={
          <Switch
            checked={versionCheckEnabled}
            onCheckedChange={(checked) =>
              void setVersionCheckEnabled(Boolean(checked))
            }
            aria-label={copy.versionCheck.ariaLabel}
          />
        }
      />
      {versionCheckEnabled && latestNewer ? (
        <SettingsRow
          label={copy.updateAvailable.label}
          help={copy.updateAvailable.help(latestNewer)}
          control={
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void handleOpenReleases()}
              disabled={opening}
            >
              <ExternalLinkIcon /> {copy.releases.openCta}
            </Button>
          }
        />
      ) : null}
      <SettingsRow
        label={copy.releases.label}
        help={copy.releases.help}
        control={
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void handleOpenReleases()}
            disabled={opening}
          >
            <ExternalLinkIcon /> {copy.releases.openCta}
          </Button>
        }
      />
    </SettingsSection>
  )
}
