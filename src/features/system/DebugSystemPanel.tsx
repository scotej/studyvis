import { useId } from 'react'

import { Kbd } from '@/components/ui/kbd'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { usePttStore } from '@/stores/pttStore'

import { useAutostart } from './useAutostart'

const isMac =
  typeof navigator !== 'undefined' &&
  /Mac|iPhone|iPad/.test(navigator.userAgent)
const MOD_LABEL = isMac ? '⌘' : 'Ctrl'

export function DebugSystemPanel() {
  const switchId = useId()
  const autostart = useAutostart()
  const pttActive = usePttStore((s) => s.active)

  const switchDisabled =
    autostart.status === 'loading' || autostart.status === 'unavailable'

  return (
    <section
      aria-label="System (temporary debug panel)"
      className="mx-auto mt-8 w-full max-w-3xl rounded-lg border border-border-subtle bg-bg-surface px-6 py-5 text-sm text-text-secondary"
    >
      <div className="mb-4 flex items-baseline justify-between">
        <h2 className="text-base font-medium text-text-primary">System</h2>
        <span className="text-xs uppercase tracking-wide text-text-muted">
          Debug · ships in V1-P11 settings
        </span>
      </div>

      <div className="flex items-center justify-between gap-4">
        <div className="flex flex-col gap-1">
          <Label htmlFor={switchId} className="text-text-primary">
            Launch StudyVis at login
          </Label>
          <span className="text-xs text-text-muted">
            Off by default. The app stays in the tray to receive invites.
          </span>
        </div>
        <Switch
          id={switchId}
          checked={autostart.enabled}
          disabled={switchDisabled}
          onCheckedChange={(value) => void autostart.toggle(value)}
        />
      </div>

      {autostart.status === 'unavailable' ? (
        <p className="mt-2 text-xs text-text-muted">
          Autostart unavailable in this build (no Tauri runtime).
        </p>
      ) : null}
      {autostart.status === 'error' && autostart.error ? (
        <p className="mt-2 text-xs text-status-alerted">{autostart.error}</p>
      ) : null}

      <div className="mt-5 flex flex-col gap-2 border-t border-border-subtle pt-4">
        <div className="flex items-center gap-2">
          <Kbd>{MOD_LABEL}</Kbd>
          <Kbd>[</Kbd>
          <span>Push to talk · friends</span>
          {pttActive ? (
            <span className="ml-auto text-xs text-status-focused">active</span>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <Kbd>{MOD_LABEL}</Kbd>
          <Kbd>]</Kbd>
          <span>Talk to AI</span>
          <span className="ml-auto text-xs text-text-muted">
            registered · V2 wires AI dialog
          </span>
        </div>
      </div>
    </section>
  )
}
