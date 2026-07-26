// I74 — the relay leg of presence. Heartbeats over trystero ride WebRTC
// datachannels, so a friend pair whose NATs a STUN-only connection can't
// traverse (no TURN ships — ARCHITECTURE §4) showed each other permanently
// offline with zero errors anywhere: trystero surfaces no callback for a
// failed ICE attempt and silently retries forever. This leg publishes the
// same heartbeat/goodbye semantics as tiny sealed ephemeral Nostr events
// straight to the pinned relays — the transport that demonstrably works
// whenever friends were added at all — so presence reflects "their app is
// running and reachable" even when the direct P2P leg can't form.
//
// The trystero datachannel heartbeat stays: it is the signal that a DIRECT
// connection works (what invites and sessions actually need), which the UI
// surfaces as the difference between plain "Available" and "limited
// connection" (see presenceState in ./presence).

import { hexToBytes } from '@/lib/crypto/identity'
import { presenceRelayKey, presenceRelayTag } from '@/lib/crypto/topics'
import {
  buildPresenceEvent,
  createThrowawaySigner,
  openPresencePayload,
  sealPresencePayload,
  type RelayPresencePayload,
} from '@/lib/nostr/events'
import {
  createRelayPool,
  type RelayPool,
  type RelayPoolConfig,
} from '@/lib/nostr/pool'
import { DEFAULT_RELAY_URLS, userRelayConfig } from '@/lib/trystero/relays'

export type PresenceRelayOptions = {
  myEdPubkey: Uint8Array
  onFriendPayload: (edPubkeyHex: string, payload: RelayPresencePayload) => void
  // Test seams.
  now?: () => number
  makePool?: (config: RelayPoolConfig) => RelayPool
}

export type PresenceRelayHandle = {
  publishHeartbeat: () => void
  publishGoodbye: () => void
  setFriends: (edPubkeyHexes: ReadonlyArray<string>) => void
  close: () => void
}

export function startPresenceRelay(
  opts: PresenceRelayOptions
): PresenceRelayHandle {
  const now = opts.now ?? (() => Date.now())
  const signer = createThrowawaySigner()
  const myTag = presenceRelayTag(opts.myEdPubkey)
  const myKey = presenceRelayKey(opts.myEdPubkey)

  const friendByTag = new Map<
    string,
    { edPubkeyHex: string; key: Uint8Array }
  >()

  const publish = (payload: RelayPresencePayload): void => {
    const event = buildPresenceEvent(
      signer,
      myTag,
      sealPresencePayload(myKey, payload),
      Math.floor(now() / 1000)
    )
    pool.publish(event)
  }

  const makePool = opts.makePool ?? createRelayPool
  const pool = makePool({
    // Custom relays extend the curated pin, same contract as trystero (#47 A5).
    urls: userRelayConfig()?.urls ?? DEFAULT_RELAY_URLS,
    onEvent: (tagValue, content) => {
      const friend = friendByTag.get(tagValue)
      if (!friend) return
      // The Poly1305 open under the friend's derived key IS the validity
      // check; anything that doesn't open is dropped silently.
      const payload = openPresencePayload(friend.key, content)
      if (payload) opts.onFriendPayload(friend.edPubkeyHex, payload)
    },
    // A relay socket (re)connecting means friends behind that relay may have
    // missed our last beat — send one now rather than waiting out the tick.
    onSocketOpen: () => publish({ v: 1 }),
  })

  return {
    publishHeartbeat: () => publish({ v: 1 }),
    publishGoodbye: () => publish({ v: 1, leaving: true }),
    setFriends: (edPubkeyHexes) => {
      friendByTag.clear()
      for (const edPubkeyHex of edPubkeyHexes) {
        let edBytes: Uint8Array
        try {
          edBytes = hexToBytes(edPubkeyHex)
        } catch {
          continue
        }
        if (edBytes.length !== 32) continue
        friendByTag.set(presenceRelayTag(edBytes), {
          edPubkeyHex,
          key: presenceRelayKey(edBytes),
        })
      }
      pool.setSubscription([...friendByTag.keys()])
    },
    close: () => pool.close(),
  }
}
