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

// Record at SEND time, not at resolution. trystero's `send` resolves a
// `Promise.all` across every peer, so a single peer with a closing data channel
// delays or rejects the whole thing — and a mirror updated on resolution would
// then hold a value the app had already moved on from, tripping the
// error-level `broadcast.disagrees_with_store` on a perfectly healthy app.
// `lastActive` is "what we last told peers", which is decided when we send.
export function recordPttBroadcast(entry: {
  active: boolean
  kind: PttBroadcastKind
}): void {
  mirror = {
    lastActive: entry.active,
    lastKind: entry.kind,
    lastSendAtMs: clock(),
    sends: mirror.sends + 1,
    sendFails: mirror.sendFails,
  }
}

// A rejection is counted without moving `lastActive`: the failure is a fact
// worth carrying, but it does not tell us what any peer now believes.
export function recordPttBroadcastFailure(): void {
  mirror = { ...mirror, sendFails: mirror.sendFails + 1 }
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
