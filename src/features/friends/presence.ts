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
//
// I74 — presence now has TWO legs feeding the same map:
// - The trystero leg (above): heartbeats over WebRTC datachannels. Stamps
//   `lastP2pAt` too, because a heartbeat that arrived over a datachannel
//   proves a DIRECT connection works — the thing invites and sessions need.
// - The relay leg (./presenceRelay): sealed ephemeral Nostr events published
//   straight to the pinned relays. No WebRTC. This is what keeps two friends
//   whose NATs block a STUN-only datachannel (no TURN ships — ARCHITECTURE
//   §4) from showing each other permanently offline: trystero fires NO
//   callback when ICE fails and silently retries forever, so before this leg
//   the failure was invisible end to end.
// A friend online via relay but with no P2P heartbeat for a settle period is
// "online, limited" (see presenceState) — visible, but the UI can warn that
// sessions may not connect and point at Settings → Network.

import { hexToBytes } from '@/lib/crypto/identity'
import { presencePassword, presenceTopic } from '@/lib/crypto/topics'
import { joinTopic, type TopicConfig, type TopicRoom } from '@/lib/trystero'
import { buildIceOptions } from '@/lib/trystero/ice'
import { userRelayConfig } from '@/lib/trystero/relays'
import { useSettingsStore } from '@/stores/settingsStore'

import {
  startPresenceRelay,
  type PresenceRelayHandle,
  type PresenceRelayOptions,
} from './presenceRelay'

export const HEARTBEAT_ACTION = 'heartbeat'
export const HEARTBEAT_INTERVAL_MS = 30_000
export const ONLINE_WINDOW_MS = 60_000
// `isOnline` is computed at render time, but React only re-renders when the
// presence map reference changes. Without this sweep, a friend going offline
// (last heartbeat ages past ONLINE_WINDOW_MS) never updates the UI because
// no new heartbeat arrives. Re-emitting on a tick shorter than the online
// window guarantees the dot flips within ~SWEEP_INTERVAL_MS of the cutoff.
export const SWEEP_INTERVAL_MS = 15_000
// I74 — how long a friend must be online with no P2P heartbeat before the UI
// calls the connection "limited". The P2P leg needs announce cycles + ICE +
// the trystero handshake before its first heartbeat can land, so flagging
// instantly would mark every freshly-arrived friend limited for a few
// seconds. Sized above realistic handshake latency, NOT reused from the 60s
// heartbeat window — the I54 review showed that borrowing that window
// misreads slow connectors.
export const LIMITED_CONNECTION_SETTLE_MS = 120_000

// F7 — the heartbeat action now carries one of two shapes on the SAME wire:
//   - a normal heartbeat `{ ts }` (unchanged), and
//   - a goodbye `{ leaving: true }` sent best-effort just before room.leave().
// Wire-compat is load-bearing in BOTH directions:
//   - OLDER receivers parse `{ leaving: true }` and hit the `typeof ts !==
//     'number'` guard below, so they DROP it (no stamp) and the sender ages out
//     via the 60s ONLINE_WINDOW_MS exactly as before — no regression.
//   - This receiver checks `leaving === true` BEFORE the ts guard and marks the
//     pubkey offline immediately.
// The goodbye deliberately omits `ts` so it can never refresh an older
// receiver's last-seen timer and accidentally DELAY their offline detection.
export type HeartbeatPayload = { ts: number }
export type GoodbyePayload = { leaving: true }
export type PresencePayload = HeartbeatPayload | GoodbyePayload

// All timestamps are receiver-local. `left` records a clean goodbye without
// discarding `lastSeenAt`, so the UI can still say "seen just now" after a
// friend quits; a REMOVED friend's entry is deleted outright. `onlineSince`
// marks the start of the current uninterrupted online stretch and only
// exists to bound the "limited" flag's settle window.
export type PresenceEntry = {
  lastSeenAt: number
  lastP2pAt?: number
  onlineSince: number
  left?: true
}

export type PresenceMap = Record<string, PresenceEntry> // keyed by ed_pubkey_hex

export type PresenceContext = {
  myEdPubkey: Uint8Array
  friends: ReadonlyArray<{ ed_pubkey_hex: string }>
  onPresenceChange: (map: PresenceMap) => void
  // Test seams.
  now?: () => number
  intervalMs?: number
  sweepIntervalMs?: number
  // I74 — relay-leg seam: omit for the real Nostr pool, pass null to disable,
  // or inject a factory returning a fake handle.
  makeRelay?: ((opts: PresenceRelayOptions) => PresenceRelayHandle) | null
}

export type PresenceSubscription = {
  leave: () => Promise<void>
  // F7 — broadcast a best-effort "leaving" flag on our own presence topic
  // without tearing the room down. Used by the hard-quit (pagehide) path where
  // there's no time to await a full `leave()`.
  sendGoodbye: () => void
  // #47 C6 (I49) — diff the friend set in place: join rooms for added
  // friends, leave rooms for removed ones, and NEVER touch the own room or
  // its heartbeat cadence. The old teardown+rebuild on any list edit
  // broadcast a goodbye that flickered our dot offline→online on every
  // friend's screen — which, since the opt-in "friend came online" OS
  // notification (N3), could ping desktops on every ContactCard import.
  updateFriends: (friends: ReadonlyArray<{ ed_pubkey_hex: string }>) => void
}

export function isOnline(
  presence: PresenceMap,
  edPubkeyHex: string,
  now: number = Date.now(),
  windowMs: number = ONLINE_WINDOW_MS
): boolean {
  const entry = presence[edPubkeyHex]
  if (!entry || entry.left) return false
  return now - entry.lastSeenAt < windowMs
}

// I74 — the richer read the friends list renders from. `limited` means the
// friend is provably reachable (relay heartbeats are landing) but no P2P
// heartbeat has arrived all settle window — the observable signature of a
// NAT pair a STUN-only connection can't traverse, which is exactly when a
// session invite is likely to fail.
export type FriendPresenceState =
  | { state: 'offline'; lastSeenAt: number | null }
  | { state: 'online'; limited: boolean }

export function presenceState(
  presence: PresenceMap,
  edPubkeyHex: string,
  now: number = Date.now(),
  windowMs: number = ONLINE_WINDOW_MS
): FriendPresenceState {
  const entry = presence[edPubkeyHex]
  if (!isOnline(presence, edPubkeyHex, now, windowMs)) {
    return { state: 'offline', lastSeenAt: entry?.lastSeenAt ?? null }
  }
  const direct =
    entry!.lastP2pAt !== undefined && now - entry!.lastP2pAt < windowMs
  const limited =
    !direct && now - entry!.onlineSince >= LIMITED_CONNECTION_SETTLE_MS
  return { state: 'online', limited }
}

export function startPresence(ctx: PresenceContext): PresenceSubscription {
  const intervalMs = ctx.intervalMs ?? HEARTBEAT_INTERVAL_MS
  const now = () => (ctx.now ? ctx.now() : Date.now())

  const presence: PresenceMap = {}
  // Own room separate from the per-friend map so friend churn can never
  // touch it (#47 C6 / I49).
  const friendRooms = new Map<string, TopicRoom>()
  // I74 — validated friend set, independent of trystero-room join success:
  // a friend whose room join failed (bad relay config) must still be
  // reachable over the relay leg.
  const friendKeys = new Set<string>()
  const heartbeatSenders: Array<(p: PresencePayload) => Promise<void[]>> = []

  // Stamp with the RECEIVER's clock. A heartbeat that just arrived means the
  // friend is reachable now, regardless of their wall clock. `p2p` records
  // which leg carried it; `lastP2pAt` only survives within an uninterrupted
  // online stretch so a stale direct-connection claim can't outlive the
  // stretch that proved it.
  const stamp = (edPubkeyHex: string, p2p: boolean): void => {
    const at = now()
    const prev = presence[edPubkeyHex]
    const streakAlive =
      prev !== undefined &&
      !prev.left &&
      at - prev.lastSeenAt < ONLINE_WINDOW_MS
    presence[edPubkeyHex] = {
      lastSeenAt: at,
      lastP2pAt: p2p ? at : streakAlive ? prev.lastP2pAt : undefined,
      onlineSince: streakAlive ? prev.onlineSince : at,
    }
    ctx.onPresenceChange({ ...presence })
  }

  // F7 — a goodbye flips the friend offline immediately rather than after
  // the 60s window. Keeps `lastSeenAt` (the friend WAS just here) so the UI
  // can say "seen just now"; a removed friend is deleted instead (below).
  const markLeft = (edPubkeyHex: string): void => {
    const prev = presence[edPubkeyHex]
    if (!prev || prev.left) return
    presence[edPubkeyHex] = { ...prev, left: true }
    ctx.onPresenceChange({ ...presence })
  }

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

  // I74 — the relay leg. Same failure posture as tryJoin: presence must
  // degrade, never crash the boot effect.
  let relay: PresenceRelayHandle | null = null
  if (ctx.makeRelay !== null) {
    const relayOpts: PresenceRelayOptions = {
      myEdPubkey: ctx.myEdPubkey,
      now,
      onFriendPayload: (edPubkeyHex, payload) => {
        if (!friendKeys.has(edPubkeyHex)) return
        if (payload.leaving === true) markLeft(edPubkeyHex)
        else stamp(edPubkeyHex, false)
      },
    }
    try {
      relay = ctx.makeRelay
        ? ctx.makeRelay(relayOpts)
        : startPresenceRelay(relayOpts)
    } catch (err) {
      console.error('presence relay leg unavailable:', err)
      relay = null
    }
  }
  const syncRelayFriends = (): void => {
    relay?.setFriends([...friendKeys])
  }

  // Own room: send heartbeats. We never read our own heartbeat back into the
  // presence map — "online to myself" is a tautology and would only confuse
  // the friends list.
  let ownJoinUnsub: () => void = () => {}
  const ownRoom = tryJoin({
    topic: presenceTopic(ctx.myEdPubkey),
    password: presencePassword(ctx.myEdPubkey),
    relayConfig: userRelayConfig(),
    // #47 C1 — race Nostr + MQTT like pairing does: a friend behind a
    // Nostr-blocking firewall could be ADDED (offline ContactCard) but then
    // showed permanently offline. Heartbeats are idempotent, so the merged
    // room's duplicate delivery is harmless (re-stamp of last-seen).
    strategies: ['nostr', 'mqtt'],
    // Heartbeats ride WebRTC datachannels, so behind a symmetric/CGNAT
    // network they need the user's TURN server exactly like sessions do —
    // without it every friend shows permanently offline even after the user
    // configured TURN to fix precisely that network. Captured at join time:
    // this room lives for the whole process, so a TURN change applies here
    // after a restart (same caveat as relays; see lib/trystero/relays.ts).
    ...buildIceOptions(useSettingsStore.getState().values.turnPreference),
    // F1 — presence is a background channel; a join error is logged only.
    onJoinError: (details) =>
      console.warn('presence (own) room join error:', details.error),
  })
  if (ownRoom) {
    const ownAction = ownRoom.makeAction<PresencePayload>(HEARTBEAT_ACTION)
    heartbeatSenders.push((p) => ownAction.send(p))
    // Send a fresh heartbeat the moment a friend subscribes to our presence
    // topic. Nostr doesn't buffer for peers who weren't on the topic yet, so
    // without this a friend who comes online between our interval ticks waits
    // up to HEARTBEAT_INTERVAL_MS to see us as online. This only triggers a
    // send; the receiver still derives "online" from its own clock (above).
    ownJoinUnsub = ownRoom.onPeerJoin(() => {
      // Same rejection guard as the interval sender below — a merged-room
      // send is a Promise.all across transports.
      void ownAction.send({ ts: now() }).catch(() => {})
    })
  }

  // Friends' rooms: listen for their heartbeats and keep the presence map.
  // Idempotent per friend so updateFriends can call it for the whole next
  // set and only genuinely new friends join a room. Callers sync the relay
  // subscription after a batch of these (syncRelayFriends), not per call.
  const subscribeFriend = (friend: { ed_pubkey_hex: string }): void => {
    let edBytes: Uint8Array
    try {
      edBytes = hexToBytes(friend.ed_pubkey_hex)
    } catch {
      return
    }
    if (edBytes.length !== 32) return
    friendKeys.add(friend.ed_pubkey_hex)
    if (friendRooms.has(friend.ed_pubkey_hex)) return

    const room = tryJoin({
      topic: presenceTopic(edBytes),
      password: presencePassword(edBytes),
      relayConfig: userRelayConfig(),
      // #47 C1 — see the own-room note above.
      strategies: ['nostr', 'mqtt'],
      // TURN for the datachannel leg — see the own-room note above.
      ...buildIceOptions(useSettingsStore.getState().values.turnPreference),
      onJoinError: (details) =>
        console.warn('presence (friend) room join error:', details.error),
    })
    if (!room) return
    friendRooms.set(friend.ed_pubkey_hex, room)
    const action = room.makeAction<PresencePayload>(HEARTBEAT_ACTION)
    action.receive((data) => {
      if (!data || typeof data !== 'object') return
      // F7 — checked BEFORE the ts guard so it works regardless of whether a
      // `ts` rides along (it shouldn't, but be defensive).
      if ((data as { leaving?: unknown }).leaving === true) {
        markLeft(friend.ed_pubkey_hex)
        return
      }
      if (typeof (data as HeartbeatPayload).ts !== 'number') return
      stamp(friend.ed_pubkey_hex, true)
    })
  }

  for (const friend of ctx.friends) subscribeFriend(friend)
  syncRelayFriends()

  // #47 C6 — leave the removed friend's room and drop their dot at once (a
  // removed friend must not linger "online" for up to ONLINE_WINDOW_MS).
  // Unlike a goodbye, removal deletes the whole entry — no ghost last-seen
  // for someone no longer in the list.
  const unsubscribeFriend = (edPubkeyHex: string): void => {
    friendKeys.delete(edPubkeyHex)
    const room = friendRooms.get(edPubkeyHex)
    if (room) {
      friendRooms.delete(edPubkeyHex)
      void room.leave().catch(() => {
        /* best-effort */
      })
    }
    if (edPubkeyHex in presence) {
      delete presence[edPubkeyHex]
      ctx.onPresenceChange({ ...presence })
    }
  }

  const updateFriends = (
    nextFriends: ReadonlyArray<{ ed_pubkey_hex: string }>
  ): void => {
    const nextKeys = new Set(nextFriends.map((f) => f.ed_pubkey_hex))
    // friendKeys ⊇ friendRooms' keys (every room passed validation first),
    // so diffing on it covers rooms AND relay-only friends.
    for (const existing of [...friendKeys]) {
      if (!nextKeys.has(existing)) unsubscribeFriend(existing)
    }
    for (const friend of nextFriends) subscribeFriend(friend)
    syncRelayFriends()
  }

  // Send the first heartbeat immediately so paired peers don't wait the full
  // interval before either side flips to "online".
  const send = () => {
    const payload: HeartbeatPayload = { ts: now() }
    for (const fn of heartbeatSenders) {
      // The merged room's send is a Promise.all across transports; a
      // datachannel dying mid-send must not surface as an unhandled
      // rejection every 30 seconds. Mirrors sendGoodbye below.
      void fn(payload).catch(() => {})
    }
    relay?.publishHeartbeat()
  }
  send()
  const heartbeatHandle = setInterval(send, intervalMs)

  // Re-emit a snapshot of the presence map on a sweep tick so the UI
  // re-evaluates `isOnline` / `presenceState` and a friend whose last
  // heartbeat aged past ONLINE_WINDOW_MS (or whose "limited" settle window
  // elapsed) visibly updates.
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
    relay?.publishGoodbye()
  }

  return {
    sendGoodbye,
    updateFriends,
    leave: async () => {
      ownJoinUnsub()
      clearInterval(heartbeatHandle)
      clearInterval(sweepHandle)
      // Announce departure to anyone listening to OUR presence topic before we
      // tear the room down. We don't await — the action's underlying datachannel
      // send is synchronous-ish, and blocking teardown on a relay round-trip
      // would defeat the "best-effort" intent. WebSocket frames queued by the
      // relay-leg goodbye flush during the closing handshake.
      sendGoodbye()
      relay?.close()
      const allRooms = [...(ownRoom ? [ownRoom] : []), ...friendRooms.values()]
      await Promise.all(
        allRooms.map((r) =>
          r.leave().catch(() => {
            /* best-effort */
          })
        )
      )
    },
  }
}
