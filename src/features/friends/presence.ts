// Presence is a separate trystero channel — see ARCHITECTURE.md §6 step 0
// and the V1-P6 prompt's optimization note. Goals:
//
// - Heartbeats are short and continuous, so keeping them on the inbox topic
//   would drown real invite payloads and make Nostr relays unhappy.
// - A friend who lost their inbox subscriber but kept presence (or vice
//   versa) is a confusing UX bug; using two distinct topics surfaces the
//   inconsistency rather than papering over it.
//
// Wire shape: a single `heartbeat` action. The receiver stamps arrival
// time with its OWN clock — cross-host wall clocks are not comparable, so
// the sender's `ts` must never be compared against the receiver's `now`
// (that caused persistent false offline/online under ordinary NTP/DST
// skew, and a backward sender clock step wedged presence permanently via
// the old monotonicity guard). Receivers update a `lastSeenAt` map keyed
// on receiver-local time and treat any pubkey whose last heartbeat landed
// within `ONLINE_WINDOW_MS` as online. We never rely on trystero's
// `onPeerJoin` for the online state — peer presence on the topic is
// necessary but not sufficient (the peer might be there with a stale
// subscriber).

import { hexToBytes } from '@/lib/crypto/identity'
import { presencePassword, presenceTopic } from '@/lib/crypto/topics'
import { joinTopic, type TopicRoom } from '@/lib/trystero'

export const HEARTBEAT_ACTION = 'heartbeat'
export const HEARTBEAT_INTERVAL_MS = 30_000
export const ONLINE_WINDOW_MS = 60_000
// `isOnline` is computed at render time, but React only re-renders when the
// presence map reference changes. Without this sweep, a friend going offline
// (last heartbeat ages past ONLINE_WINDOW_MS) never updates the UI because
// no new heartbeat arrives. Re-emitting on a tick shorter than the online
// window guarantees the dot flips within ~SWEEP_INTERVAL_MS of the cutoff.
export const SWEEP_INTERVAL_MS = 15_000

export type HeartbeatPayload = {
  ts: number
}

export type PresenceMap = Record<string, number> // ed_pubkey_hex -> last seen ms

export type PresenceContext = {
  myEdPubkey: Uint8Array
  friends: ReadonlyArray<{ ed_pubkey_hex: string }>
  onPresenceChange: (map: PresenceMap) => void
  // Test seams.
  now?: () => number
  intervalMs?: number
  sweepIntervalMs?: number
}

export type PresenceSubscription = {
  leave: () => Promise<void>
}

export function isOnline(
  presence: PresenceMap,
  edPubkeyHex: string,
  now: number = Date.now(),
  windowMs: number = ONLINE_WINDOW_MS
): boolean {
  const last = presence[edPubkeyHex]
  if (typeof last !== 'number') return false
  return now - last < windowMs
}

export function startPresence(ctx: PresenceContext): PresenceSubscription {
  const intervalMs = ctx.intervalMs ?? HEARTBEAT_INTERVAL_MS
  const now = () => (ctx.now ? ctx.now() : Date.now())

  const presence: PresenceMap = {}
  const rooms: TopicRoom[] = []
  const heartbeatSenders: Array<(p: HeartbeatPayload) => Promise<void[]>> = []

  // Own room: send heartbeats. We never read our own heartbeat back into the
  // presence map — "online to myself" is a tautology and would only confuse
  // the friends list.
  const ownRoom = joinTopic({
    topic: presenceTopic(ctx.myEdPubkey),
    password: presencePassword(ctx.myEdPubkey),
  })
  rooms.push(ownRoom)
  const ownAction = ownRoom.makeAction<HeartbeatPayload>(HEARTBEAT_ACTION)
  heartbeatSenders.push((p) => ownAction.send(p))

  // Friends' rooms: listen for their heartbeats and keep a `lastSeenAt` map.
  for (const friend of ctx.friends) {
    let edBytes: Uint8Array
    try {
      edBytes = hexToBytes(friend.ed_pubkey_hex)
    } catch {
      continue
    }
    if (edBytes.length !== 32) continue

    const room = joinTopic({
      topic: presenceTopic(edBytes),
      password: presencePassword(edBytes),
    })
    rooms.push(room)
    const action = room.makeAction<HeartbeatPayload>(HEARTBEAT_ACTION)
    action.receive((data) => {
      if (!data || typeof (data as HeartbeatPayload).ts !== 'number') return
      // Stamp with the RECEIVER's clock. A heartbeat that just arrived
      // means the friend is reachable now, regardless of their wall clock.
      presence[friend.ed_pubkey_hex] = now()
      ctx.onPresenceChange({ ...presence })
    })
  }

  // Send the first heartbeat immediately so paired peers don't wait the full
  // interval before either side flips to "online".
  const send = () => {
    const payload: HeartbeatPayload = { ts: now() }
    for (const fn of heartbeatSenders) void fn(payload)
  }
  send()
  const heartbeatHandle = setInterval(send, intervalMs)

  // Re-emit a snapshot of the presence map on a sweep tick so the UI
  // re-evaluates `isOnline` and a friend whose last heartbeat aged past
  // ONLINE_WINDOW_MS visibly flips to offline.
  const sweepHandle = setInterval(() => {
    ctx.onPresenceChange({ ...presence })
  }, ctx.sweepIntervalMs ?? SWEEP_INTERVAL_MS)

  return {
    leave: async () => {
      clearInterval(heartbeatHandle)
      clearInterval(sweepHandle)
      await Promise.all(
        rooms.map((r) =>
          r.leave().catch(() => {
            /* best-effort */
          })
        )
      )
    },
  }
}
