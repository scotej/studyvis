import { useCallback, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { ExternalLinkIcon } from 'lucide-react'
import { toast } from 'sonner'

import { SettingsRow, SettingsSection } from '@/components/SettingsRow'
import { Button } from '@/components/ui/button'
import { strings } from '@/strings'

const COPYRIGHT_LINE = strings.settings.about.copyright.line(
  new Date().getFullYear()
)

export function AboutCategory() {
  const [opening, setOpening] = useState(false)
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
