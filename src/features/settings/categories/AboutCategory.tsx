import { useCallback, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { ExternalLinkIcon } from 'lucide-react'
import { toast } from 'sonner'

import { SettingsRow, SettingsSection } from '@/components/SettingsRow'
import { Button } from '@/components/ui/button'

const RELEASES_URL = 'https://github.com/scotej/studyvis/releases'

const COPYRIGHT_LINE = `© ${new Date().getFullYear()} Scott — all rights reserved`

export function AboutCategory() {
  const [opening, setOpening] = useState(false)

  const handleOpenReleases = useCallback(async () => {
    setOpening(true)
    try {
      await invoke('system_open_url', { url: RELEASES_URL })
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Could not open Releases page.'
      toast.error(message)
    } finally {
      setOpening(false)
    }
  }, [])

  return (
    <SettingsSection heading="About">
      <SettingsRow
        label="StudyVis"
        help="Peer-to-peer study app for friends. Local-first, no backend."
      />
      <SettingsRow
        label="Version"
        control={
          <span className="font-mono text-sm text-text-secondary">
            {__APP_VERSION__}
          </span>
        }
      />
      <SettingsRow label="License" help={COPYRIGHT_LINE} />
      <SettingsRow
        label="Releases"
        help="StudyVis doesn't auto-update. Check here when a new version drops."
        control={
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void handleOpenReleases()}
            disabled={opening}
          >
            <ExternalLinkIcon /> Open
          </Button>
        }
      />
    </SettingsSection>
  )
}
