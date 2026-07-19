import {
  getMqttRelaySocketMap,
  getRelaySocketMap,
  type RelaySocketMap,
} from '@/lib/trystero'

// F2 — pure helpers behind the Settings → Network connection panel. Kept out of
// the component file so the React fast-refresh boundary stays component-only.

export type RelayStatus = 'connected' | 'connecting' | 'down'

// #47 C3 — rows carry their discovery transport so the diagnostics panel can
// show the MQTT broker sockets alongside the Nostr relays. Pairing races both
// (PR-21), so on a Nostr-blocked/MQTT-working network the panel previously
// showed everything down while pairing succeeded — the exact case the I31
// failure hint sends users here to diagnose.
export type RelayTransport = 'nostr' | 'mqtt'

export type RelayRow = {
  url: string
  status: RelayStatus
  transport: RelayTransport
}

// WebSocket.readyState: 0 CONNECTING, 1 OPEN, 2 CLOSING, 3 CLOSED.
export function readyStateToStatus(readyState: number): RelayStatus {
  if (readyState === 1) return 'connected'
  if (readyState === 0) return 'connecting'
  return 'down'
}

function rowsFromSocketMap(
  map: RelaySocketMap,
  transport: RelayTransport
): RelayRow[] {
  return Object.entries(map)
    .map(([url, socket]) => ({
      url,
      status: readyStateToStatus(socket?.readyState ?? 3),
      transport,
    }))
    .sort((a, b) => a.url.localeCompare(b.url))
}

// Snapshot trystero's live NOSTR socket map into a sorted, render-ready row
// list (Nostr-only by contract; the panel uses snapshotAllRelayRows).
export function snapshotRelayRows(): RelayRow[] {
  return rowsFromSocketMap(getRelaySocketMap(), 'nostr')
}

// #47 C3 — both transports, for the diagnostics panel. Since #47 C1 the
// always-on inbox + presence rooms race MQTT too, so the MQTT group
// populates moments after launch (it was pairing-only when this shipped);
// the panel still renders it only when present.
export function snapshotAllRelayRows(): RelayRow[] {
  return [
    ...rowsFromSocketMap(getRelaySocketMap(), 'nostr'),
    ...rowsFromSocketMap(getMqttRelaySocketMap(), 'mqtt'),
  ]
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

// PR-21 — transport-aware reachability for the PAIRING dialog, which races
// Nostr + MQTT (see joinTopic strategies). `relaysUnreachable()` above reads
// only the Nostr socket map, so on a network that blocks every curated Nostr
// relay but allows MQTT — the exact case the dual-transport race was added to
// survive — it wrongly reports the network down and pushes the user to cancel a
// pairing that MQTT would complete. Judge both transports: the network is down
// only when at least one socket exists across Nostr OR MQTT and NONE of them is
// OPEN. Returns false when neither transport has opened a socket yet (nothing to
// judge). Since #47 C1 the invite send path races MQTT too and uses this same
// signal; the Nostr-only `relaysUnreachable` above remains for diagnostics.
export function pairingRelaysUnreachable(): boolean {
  const nostr = getRelaySocketMap()
  const mqtt = getMqttRelaySocketMap()
  const sockets = [...Object.values(nostr), ...Object.values(mqtt)]
  if (sockets.length === 0) return false
  return sockets.every((socket) => (socket?.readyState ?? 3) !== 1)
}
