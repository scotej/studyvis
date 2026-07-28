// I74 — a small owned WebSocket pool over the pinned Nostr relays for the
// relay-presence leg. Deliberately NOT piggybacked on trystero's sockets:
// trystero rebuilds the socket object on every reconnect (listeners attached
// by us would silently die), owns the `onmessage` property, and re-issues only
// ITS subscriptions on reopen. Owning the sockets means reconnection,
// re-subscription, and re-publish-on-reopen are deterministic here, at the
// cost of a second socket per relay (~7 idle WebSockets — within PLAN §2's
// idle network budget).
//
// One pool = one live subscription covering many tag values: NIP-01 filter
// arrays are OR'd, so `{"#x": [tagA, tagB, ...]}` under a single subId covers
// every friend, and a friend-list edit re-issues the same subId (relays
// replace the filter in place). `limit: 0` asks for zero stored events —
// belt-and-suspenders on top of the ephemeral kind, so a non-compliant relay
// that stores kind-20001 events can't dump stale heartbeats at subscribe
// time and stamp a phantom "online". No `since` filter, ever (see events.ts
// on the clock-skew trap).

import { bytesToHex } from '@/lib/encoding'
import { logger } from '@/lib/log'
import { PRESENCE_EVENT_KIND, type NostrEvent } from './events'

// I80 — the text in an OK-false reason or a NOTICE is written by the relay,
// and the log is what a friend pastes into a bug report. The private forLog()
// that used to live here is now sanitizeText() inside the logger, applied to
// every field of every record, so relay-authored text is stripped and clamped
// wherever it lands rather than only at the two sites that were audited.
const log = logger.child('nostr.pool')

// The structural subset of WebSocket the pool needs; tests inject fakes.
export type PoolSocket = {
  readyState: number
  send: (data: string) => void
  close: () => void
  addEventListener: (
    type: 'open' | 'message' | 'close' | 'error',
    fn: (evt: { data?: unknown }) => void
  ) => void
}

export type RelayPoolConfig = {
  urls: string[]
  // Fires for every event that passes subId + kind + tag + dedupe checks.
  onEvent: (tagValue: string, content: string) => void
  // Fires each time a socket (re)opens, AFTER the subscription is re-issued.
  // Receives a publisher scoped to THAT socket: the presence leg uses it to
  // send a fresh heartbeat only where it's needed, so a relay blip doesn't
  // cost friends behind that relay up to a full heartbeat interval — and a
  // flapping relay can't fan republishes out to every healthy one.
  onSocketOpen?: (publishHere: (event: NostrEvent) => void) => void
  // Test seams.
  makeSocket?: (url: string) => PoolSocket
  reconnectBaseMs?: number
  reconnectMaxMs?: number
}

export type RelayPool = {
  // Replace the subscribed tag set (empty array closes the subscription).
  setSubscription: (tagValues: string[]) => void
  publish: (event: NostrEvent) => void
  close: () => void
}

const RECONNECT_BASE_MS = 5_000
const RECONNECT_MAX_MS = 60_000
// A connection must survive this long before a close resets the backoff
// counter. Resetting on `open` alone defeats exponential backoff for the
// exact failure class it exists for: a relay that accepts the socket and
// drops it moments later (rate-limit disconnect, AUTH-required policy,
// captive portal) would loop at the base delay forever.
const STABLE_CONNECTION_MS = 60_000
const SEEN_IDS_CAP = 512

type SocketSlot = {
  url: string
  socket: PoolSocket | null
  attempts: number
  openedAt: number | null
  timer: ReturnType<typeof setTimeout> | null
  gaveUp: boolean
}

export function createRelayPool(config: RelayPoolConfig): RelayPool {
  const makeSocket =
    config.makeSocket ?? ((url: string) => new WebSocket(url) as PoolSocket)
  const baseMs = config.reconnectBaseMs ?? RECONNECT_BASE_MS
  const maxMs = config.reconnectMaxMs ?? RECONNECT_MAX_MS

  const subId = `sv-presence-${bytesToHex(crypto.getRandomValues(new Uint8Array(4)))}`
  let tags: string[] = []
  let closed = false

  // Set iteration is insertion-ordered, so capping evicts the oldest first.
  // Every relay broadcasts the same event, so ~(relays × friends) live ids
  // at a time.
  const seenIds = new Set<string>()

  const slots: SocketSlot[] = config.urls.map((url) => ({
    url,
    socket: null,
    attempts: 0,
    openedAt: null,
    timer: null,
    gaveUp: false,
  }))

  const sendSubscription = (socket: PoolSocket): void => {
    if (socket.readyState !== 1) return
    if (tags.length === 0) {
      socket.send(JSON.stringify(['CLOSE', subId]))
      return
    }
    socket.send(
      JSON.stringify([
        'REQ',
        subId,
        { kinds: [PRESENCE_EVENT_KIND], '#x': tags, limit: 0 },
      ])
    )
  }

  const handleMessage = (url: string, raw: unknown): void => {
    let frame: unknown[]
    try {
      frame = JSON.parse(String(raw)) as unknown[]
    } catch {
      return
    }
    if (!Array.isArray(frame)) return
    // This leg exists because the OTHER transport fails silently — so it
    // must not fail silently itself. A relay refusing our publishes
    // (`["OK", id, false, reason]` — e.g. a web-of-trust policy, or a
    // clock-skewed sender tripping a created_at bound) or complaining via
    // NOTICE is exactly what a future "presence stopped working on relay X"
    // report needs in the console. check-relays catches this at release
    // time only; policies change between releases (offchain.pub did).
    if (frame[0] === 'OK' && frame[2] === false) {
      log.warn('relay.rejected', {
        relayUrl: url,
        eventId: frame[1],
        reason: frame[3],
      })
      return
    }
    if (frame[0] === 'NOTICE') {
      log.warn('relay.notice', { relayUrl: url, subId, notice: frame[1] })
      return
    }
    if (frame[0] !== 'EVENT' || frame[1] !== subId) return
    const event = frame[2] as Partial<NostrEvent> | undefined
    if (!event || typeof event !== 'object') return
    if (event.kind !== PRESENCE_EVENT_KIND) return
    if (typeof event.id !== 'string' || typeof event.content !== 'string')
      return
    const tagValue = Array.isArray(event.tags)
      ? event.tags.find(
          (t) => Array.isArray(t) && t[0] === 'x' && tags.includes(t[1])
        )?.[1]
      : undefined
    if (typeof tagValue !== 'string') return
    if (seenIds.has(event.id)) return
    seenIds.add(event.id)
    if (seenIds.size > SEEN_IDS_CAP) {
      const oldest = seenIds.values().next().value
      if (oldest !== undefined) seenIds.delete(oldest)
    }
    config.onEvent(tagValue, event.content)
  }

  const sendEventTo = (socket: PoolSocket, event: NostrEvent): void => {
    if (socket.readyState !== 1) return
    try {
      socket.send(JSON.stringify(['EVENT', event]))
    } catch {
      // A dying socket surfaces via its close/error listener; a failed
      // publish is covered by the next heartbeat tick.
    }
  }

  const connect = (slot: SocketSlot): void => {
    if (closed || slot.gaveUp) return
    let socket: PoolSocket
    try {
      socket = makeSocket(slot.url)
    } catch (err) {
      // A constructor throw is a malformed URL, not a network blip —
      // retrying re-throws forever. Give up on this URL only.
      log.warn('relay.bad_url', { relayUrl: slot.url, gaveUp: true, err })
      slot.gaveUp = true
      return
    }
    slot.socket = socket
    let settled = false
    const scheduleReconnect = (): void => {
      if (closed || settled) return
      settled = true
      // Close explicitly: `error` without a following `close` would leave an
      // orphan socket that could still open later, double-subscribing beside
      // its replacement.
      try {
        socket.close()
      } catch {
        // already closed
      }
      slot.socket = null
      // Only a connection that proved stable earns a backoff reset — see
      // STABLE_CONNECTION_MS above.
      if (
        slot.openedAt !== null &&
        Date.now() - slot.openedAt >= STABLE_CONNECTION_MS
      ) {
        slot.attempts = 0
      }
      slot.openedAt = null
      const delay = Math.min(maxMs, baseMs * 2 ** slot.attempts)
      slot.attempts += 1
      slot.timer = setTimeout(() => {
        slot.timer = null
        connect(slot)
      }, delay)
    }
    socket.addEventListener('open', () => {
      slot.openedAt = Date.now()
      sendSubscription(socket)
      config.onSocketOpen?.((event) => sendEventTo(socket, event))
    })
    socket.addEventListener('message', (evt) =>
      handleMessage(slot.url, evt.data)
    )
    socket.addEventListener('close', scheduleReconnect)
    socket.addEventListener('error', scheduleReconnect)
  }

  for (const slot of slots) connect(slot)

  return {
    setSubscription: (tagValues) => {
      tags = [...tagValues]
      for (const slot of slots) {
        if (slot.socket) sendSubscription(slot.socket)
      }
    },
    publish: (event) => {
      for (const slot of slots) {
        if (slot.socket) sendEventTo(slot.socket, event)
      }
    },
    close: () => {
      closed = true
      for (const slot of slots) {
        if (slot.timer !== null) clearTimeout(slot.timer)
        slot.timer = null
        try {
          slot.socket?.close()
        } catch {
          // already closed
        }
        slot.socket = null
      }
    },
  }
}
