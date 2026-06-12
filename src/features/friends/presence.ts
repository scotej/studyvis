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
import { joinTopic, type TopicConfig, type TopicRoom } from '@/lib/trystero'
import { userRelayConfig } from '@/lib/trystero/relays'

export const HEARTBEAT_ACTION = 'heartbeat'
export const HEARTBEAT_INTERVAL_MS = 30_000
export const ONLINE_WINDOW_MS = 60_000
// `isOnline` is computed at render time, but React only re-renders when the
// presence map reference changes. Without this sweep, a friend going offline
// (last heartbeat ages past ONLINE_WINDOW_MS) never updates the UI because
// no new heartbeat arrives. Re-emitting on a tick shorter than the online
// window guarantees the dot flips within ~SWEEP_INTERVAL_MS of the cutoff.
export const SWEEP_INTERVAL_MS = 15_000

// F7 — the heartbeat action now carries one of two shapes on the SAME wire:
//   - a normal heartbeat `{ ts }` (unchanged), and
//   - a goodbye `{ leaving: true }` sent best-effort just before room.leave().
// Wire-compat is load-bearing in BOTH directions:
//   - OLDER receivers parse `{ leaving: true }` and hit the `typeof ts !==
//     'number'` guard below, so they DROP it (no stamp) and the sender ages out
//     via the 60s ONLINE_WINDOW_MS exactly as before — no regression.
//   - This receiver checks `leaving === true` BEFORE the ts guard and marks the
//     pubkey offline immediately (deletes it from the map).
// The goodbye deliberately omits `ts` so it can never refresh an older
// receiver's last-seen timer and accidentally DELAY their offline detection.
export type HeartbeatPayload = { ts: number }
export type GoodbyePayload = { leaving: true }
export type PresencePayload = HeartbeatPayload | GoodbyePayload

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
  // F7 — broadcast a best-effort "leaving" flag on our own presence topic
  // without tearing the room down. Used by the hard-quit (pagehide) path where
  // there's no time to await a full `leave()`.
  sendGoodbye: () => void
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
  const heartbeatSenders: Array<(p: PresencePayload) => Promise<void[]>> = []

  // F3 — `joinTopic` builds the relay WebSockets synchronously, so a malformed
  // saved relay URL throws here. `startPresence` runs in InboxBoot's mount
  // effect with no React error boundary above it, so an unguarded throw would
  // blank the whole app at launch. Each join is wrapped so a bad relay config
  // degrades presence to a no-op instead of crashing the app; the user can
  // still reach Settings → Network to fix the list.
  const tryJoin = (config: TopicConfig): TopicRoom | null => {
    try {
      return joinTopic(config)
    } catch (err) {
      console.error('presence room join failed:', err)
      return null
    }
  }

  // Own room: send heartbeats. We never read our own heartbeat back into the
  // presence map — "online to myself" is a tautology and would only confuse
  // the friends list.
  let ownJoinUnsub: () => void = () => {}
  const ownRoom = tryJoin({
    topic: presenceTopic(ctx.myEdPubkey),
    password: presencePassword(ctx.myEdPubkey),
    relayConfig: userRelayConfig(),
    // F1 — presence is a background channel; a join error is logged only.
    onJoinError: (details) =>
      console.warn('presence (own) room join error:', details.error),
  })
  if (ownRoom) {
    rooms.push(ownRoom)
    const ownAction = ownRoom.makeAction<PresencePayload>(HEARTBEAT_ACTION)
    heartbeatSenders.push((p) => ownAction.send(p))
    // Send a fresh heartbeat the moment a friend subscribes to our presence
    // topic. Nostr doesn't buffer for peers who weren't on the topic yet, so
    // without this a friend who comes online between our interval ticks waits
    // up to HEARTBEAT_INTERVAL_MS to see us as online. This only triggers a
    // send; the receiver still derives "online" from its own clock (above).
    ownJoinUnsub = ownRoom.onPeerJoin(() => {
      void ownAction.send({ ts: now() })
    })
  }

  // Friends' rooms: listen for their heartbeats and keep a `lastSeenAt` map.
  for (const friend of ctx.friends) {
    let edBytes: Uint8Array
    try {
      edBytes = hexToBytes(friend.ed_pubkey_hex)
    } catch {
      continue
    }
    if (edBytes.length !== 32) continue

    const room = tryJoin({
      topic: presenceTopic(edBytes),
      password: presencePassword(edBytes),
      relayConfig: userRelayConfig(),
      onJoinError: (details) =>
        console.warn('presence (friend) room join error:', details.error),
    })
    if (!room) continue
    rooms.push(room)
    const action = room.makeAction<PresencePayload>(HEARTBEAT_ACTION)
    action.receive((data) => {
      if (!data || typeof data !== 'object') return
      // F7 — a goodbye flips the friend offline immediately. Checked BEFORE the
      // ts guard so it works regardless of whether a `ts` rides along (it
      // shouldn't, but be defensive). Deleting the entry makes isOnline return
      // false this instant rather than after the 60s window.
      if ((data as { leaving?: unknown }).leaving === true) {
        if (friend.ed_pubkey_hex in presence) {
          delete presence[friend.ed_pubkey_hex]
          ctx.onPresenceChange({ ...presence })
        }
        return
      }
      if (typeof (data as HeartbeatPayload).ts !== 'number') return
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

  // F7 — best-effort goodbye on our own presence topic so friends currently
  // subscribed flip us offline near-instantly instead of waiting out the 60s
  // window. Fire-and-forget; a failed send must never block teardown.
  const sendGoodbye = (): void => {
    for (const fn of heartbeatSenders) {
      try {
        void fn({ leaving: true }).catch(() => {})
      } catch {
        /* best-effort */
      }
    }
  }

  return {
    sendGoodbye,
    leave: async () => {
      ownJoinUnsub()
      clearInterval(heartbeatHandle)
      clearInterval(sweepHandle)
      // Announce departure to anyone listening to OUR presence topic before we
      // tear the room down. We don't await — the action's underlying datachannel
      // send is synchronous-ish, and blocking teardown on a relay round-trip
      // would defeat the "best-effort" intent.
      sendGoodbye()
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
