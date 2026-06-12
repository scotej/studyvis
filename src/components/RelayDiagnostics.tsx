import { useEffect, useState } from 'react'

import { cn } from '@/lib/utils'
import {
  snapshotRelayRows,
  type RelayRow,
  type RelayStatus,
} from '@/lib/relayDiagnostics'
import { strings } from '@/strings'

// F2 — live per-relay connection status for Settings → Network. trystero keeps
// one WebSocket per signaling relay; this reads their `readyState` on a modest
// tick while the panel is mounted (the panel only mounts when the Network
// settings category is open). Pure local read — no telemetry, no network call
// of our own. Color is never the sole signal: every dot is paired with a text
// status label and an aria-label, per DESIGN-SYSTEM §11.

const POLL_INTERVAL_MS = 2_000

export type RelayDiagnosticsProps = {
  // Test/Storybook seam: render a fixed row set instead of polling trystero.
  // When provided, the component is fully controlled and never polls.
  rows?: RelayRow[]
  // Test/Storybook seam: override the live snapshot source.
  snapshot?: () => RelayRow[]
}

export function RelayDiagnostics({ rows, snapshot }: RelayDiagnosticsProps) {
  if (rows) return <RelayList rows={rows} />
  return <LiveRelayList snapshot={snapshot} />
}

function LiveRelayList({ snapshot }: { snapshot?: () => RelayRow[] }) {
  const take = snapshot ?? snapshotRelayRows
  const [live, setLive] = useState<RelayRow[]>(take)

  useEffect(() => {
    // Re-poll on a tick. The first read happens inside the interval's initial
    // tick scheduling plus the lazy useState initializer above, so we never
    // set state synchronously in the effect body.
    const id = setInterval(() => setLive(take()), POLL_INTERVAL_MS)
    return () => clearInterval(id)
    // `take` is derived from the `snapshot` prop; re-poll if it changes.
  }, [snapshot]) // eslint-disable-line react-hooks/exhaustive-deps

  return <RelayList rows={live} />
}

function RelayList({ rows }: { rows: RelayRow[] }) {
  const copy = strings.settings.network.diagnostics
  if (rows.length === 0) {
    return <p className="text-xs text-text-muted">{copy.empty}</p>
  }
  return (
    <ul className="flex flex-col gap-2">
      {rows.map((row) => (
        <li
          key={row.url}
          className="flex items-center gap-3 rounded-md border border-border-subtle bg-bg-sunk px-3 py-2"
        >
          <RelayDot status={row.status} url={row.url} />
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-text-secondary">
            {row.url}
          </span>
          <span
            className={cn(
              'shrink-0 text-xs',
              row.status === 'connected'
                ? 'text-status-focused'
                : row.status === 'connecting'
                  ? 'text-status-warning'
                  : 'text-text-muted'
            )}
          >
            {copy.status[row.status]}
          </span>
        </li>
      ))}
    </ul>
  )
}

function RelayDot({ status, url }: { status: RelayStatus; url: string }) {
  const copy = strings.settings.network.diagnostics
  return (
    <span
      role="img"
      aria-label={copy.dotAriaLabel(url, copy.status[status])}
      className={cn(
        'inline-flex size-2.5 shrink-0 rounded-full',
        status === 'connected'
          ? 'bg-status-focused'
          : status === 'connecting'
            ? 'bg-status-warning'
            : 'border-2 border-status-offline bg-transparent'
      )}
    />
  )
}
