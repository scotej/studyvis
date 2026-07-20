import { useEffect, useState } from 'react'

import { cn } from '@/lib/utils'
import {
  snapshotAllRelayRows,
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
  const take = snapshot ?? snapshotAllRelayRows
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
  // #47 C3 — group by transport so the MQTT broker sockets (raced alongside
  // Nostr for pairing, PR-21) are visible: on a Nostr-blocked/MQTT-working
  // network the panel used to show everything down while pairing succeeded.
  const nostr = rows.filter((row) => row.transport === 'nostr')
  const mqtt = rows.filter((row) => row.transport === 'mqtt')
  return (
    <div className="flex flex-col gap-3">
      {nostr.length > 0 ? (
        <TransportGroup heading={copy.transport.nostr} rows={nostr} />
      ) : null}
      {mqtt.length > 0 ? (
        <TransportGroup heading={copy.transport.mqtt} rows={mqtt} />
      ) : null}
    </div>
  )
}

function TransportGroup({
  heading,
  rows,
}: {
  heading: string
  rows: RelayRow[]
}) {
  const copy = strings.settings.network.diagnostics
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs font-medium text-text-muted">{heading}</p>
      <ul className="flex flex-col gap-2" aria-label={heading}>
        {rows.map((row) => (
          <li
            key={row.url}
            className="flex items-center gap-3 rounded-md border border-border-subtle bg-bg-sunk px-3 py-2"
          >
            <RelayDot status={row.status} url={row.url} />
            {/* title: two long custom relay URLs can truncate identically;
                hover reveals the full value without widening the row. */}
            <span
              className="min-w-0 flex-1 truncate font-mono text-xs text-text-secondary"
              title={row.url}
            >
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
    </div>
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
