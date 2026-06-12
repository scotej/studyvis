import { getRelaySocketMap } from '@/lib/trystero'

// F2 — pure helpers behind the Settings → Network connection panel. Kept out of
// the component file so the React fast-refresh boundary stays component-only.

export type RelayStatus = 'connected' | 'connecting' | 'down'

export type RelayRow = { url: string; status: RelayStatus }

// WebSocket.readyState: 0 CONNECTING, 1 OPEN, 2 CLOSING, 3 CLOSED.
export function readyStateToStatus(readyState: number): RelayStatus {
  if (readyState === 1) return 'connected'
  if (readyState === 0) return 'connecting'
  return 'down'
}

// Snapshot trystero's live socket map into a sorted, render-ready row list.
export function snapshotRelayRows(): RelayRow[] {
  const map = getRelaySocketMap()
  return Object.entries(map)
    .map(([url, socket]) => ({
      url,
      status: readyStateToStatus(socket?.readyState ?? 3),
    }))
    .sort((a, b) => a.url.localeCompare(b.url))
}

// F1/F6 — the real "the network is unreachable" signal. trystero's
// `onJoinError` does NOT fire when relays are blocked (it only fires on a
// room-password decrypt failure or a post-rendezvous handshake error — both
// require a peer to already be signaling), so a school/corporate network that
// blocks every relay produces no join error at all. The honest detector is the
// socket map: if at least one relay has ever been joined and NONE of them is
// OPEN, the user's network can't reach the signaling layer. Returns false when
// no room has been joined yet (nothing to judge) so callers don't misread a
// pre-rendezvous state as "blocked".
export function relaysUnreachable(): boolean {
  const rows = snapshotRelayRows()
  if (rows.length === 0) return false
  return rows.every((row) => row.status !== 'connected')
}
