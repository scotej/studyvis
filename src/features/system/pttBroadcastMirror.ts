// #226 — `SessionView` broadcasts local PTT state to peers and discards the
// send promise, so "what we told the peer" existed nowhere in the archive. A
// peer who could not hear the user was therefore indistinguishable from a peer
// who was told the wrong thing.
//
// This mirrors our own outbound wire state. It is strictly read-only with
// respect to `PTT_STATE_ACTION`: no payload field, no sequence number, no new
// action. That message is a cross-version peer contract, and observing what we
// send is in scope while changing it is not.
//
// Delivery to the far end still needs the peer's own archive — this proves
// what left, not what arrived.

export type PttBroadcastKind = 'state-change' | 'resend'

export type PttBroadcastMirror = {
  lastActive: boolean | null
  lastKind: PttBroadcastKind | null
  lastSendAtMs: number | null
  sends: number
  sendFails: number
}

type Clock = () => number

const defaultClock: Clock = () =>
  typeof performance === 'undefined' ? Date.now() : performance.now()

let clock: Clock = defaultClock
let mirror: PttBroadcastMirror = {
  lastActive: null,
  lastKind: null,
  lastSendAtMs: null,
  sends: 0,
  sendFails: 0,
}

export function __setPttBroadcastClock(next: Clock): void {
  clock = next
}

export function __resetPttBroadcastClock(): void {
  clock = defaultClock
}

export function recordPttBroadcast(entry: {
  active: boolean
  kind: PttBroadcastKind
  ok: boolean
}): void {
  if (!entry.ok) {
    // A rejected send did NOT change what the peer believes, so the last
    // known-good value must stand — moving it would manufacture agreement.
    mirror = { ...mirror, sendFails: mirror.sendFails + 1 }
    return
  }
  mirror = {
    lastActive: entry.active,
    lastKind: entry.kind,
    lastSendAtMs: clock(),
    sends: mirror.sends + 1,
    sendFails: mirror.sendFails,
  }
}

export function readPttBroadcastMirror(): PttBroadcastMirror & {
  msSinceSend: number | null
} {
  return {
    ...mirror,
    msSinceSend:
      mirror.lastSendAtMs === null
        ? null
        : Math.max(0, Math.round(clock() - mirror.lastSendAtMs)),
  }
}

// A room owns its broadcast history: carrying the previous room's last value
// into a new one would let the watchdog compare against a peer set that no
// longer exists.
export function resetPttBroadcastMirror(): void {
  mirror = {
    lastActive: null,
    lastKind: null,
    lastSendAtMs: null,
    sends: 0,
    sendFails: 0,
  }
}
