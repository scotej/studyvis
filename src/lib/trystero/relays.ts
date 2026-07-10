import { useSettingsStore } from '@/stores/settingsStore'

// Curated Nostr signaling relays for trystero room rendezvous.
//
// Trystero's default Nostr strategy does NOT pick relays at random per peer: it
// shuffles its bundled ~56-relay list with a seed derived ONLY from the appId
// ('studyvis') and takes the first `redundancy` (5). So every peer on the same
// version deterministically targets the IDENTICAL 5 relays — discovery overlap
// between two peers is 100% by construction. The real risk is the opposite of
// "they didn't share a relay": the appId hash may land on low-uptime community
// relays, or relays unreachable from a school/corporate network, and there is
// no per-peer diversity or fallback — so discovery fails symmetrically for
// everyone with no recovery.
//
// Passing relayConfig.urls makes trystero use this ENTIRE list (its `redundancy`
// knob is then ignored), so we replace "whichever 5 the appId hash happened to
// pick" with a set we have verified speaks Nostr and accepts anonymous
// ephemeral events — the exact publish/subscribe round-trip trystero rendezvous
// depends on. Listing more than the default 5 also adds headroom against a
// correlated outage.
//
// Like PUBLIC_TURN_SERVERS in ./ice, this is network config (not design
// tokens), so it lives here rather than in src/design/tokens.ts. Relays die:
// every entry below was verified live on 2026-06-01 via an ephemeral-event
// round-trip (publish on one connection, receive on a subscribed one). Re-verify
// before trusting a stale list and drop any that go dark — at that time
// relay.damus.io and relay.froth.zone were unreachable and are deliberately
// omitted despite being in trystero's default pool.
export const DEFAULT_RELAY_URLS: string[] = [
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://relay.nostr.place',
  'wss://relay.mostr.pub',
  'wss://offchain.pub',
  'wss://relay.snort.social',
  'wss://relay.0xchat.com',
  'wss://purplerelay.com',
]

// #47 A5 — custom relays EXTEND the curated pin, never replace it. Replacement
// was a silent symmetric footgun: the one friend who added a self-hosted relay
// stopped sharing any relay with friends on the defaults, severing discovery
// in both directions — the exact failure mode the curated pin exists to avoid.
// Custom URLs go first (the user added them for a reason, e.g. a network where
// the defaults are blocked); order only affects connection attempts, since
// rendezvous succeeds on ANY shared relay.
export function mergedRelayUrls(custom: string[]): string[] {
  return [...new Set([...custom, ...DEFAULT_RELAY_URLS])]
}

// F3 — resolve the relay override from the user's Settings → Network → Advanced
// list. Returns `{ urls }` only when the user configured at least one custom
// wss:// relay — the union of custom + defaults (see mergedRelayUrls) —
// otherwise `undefined`, so joinTopic falls through to its DEFAULT_RELAY_URLS
// pin. Passing `urls` makes trystero use that ENTIRE list (its `redundancy`
// knob is ignored) — same contract as the default pin.
//
// Read lazily from the store at call time, but note that in practice a relay
// change does NOT take effect until the app is relaunched: trystero constructs
// its relay sockets once per process (its `init` runs only when the FIRST room
// is joined and is not re-run while any room stays open), and the inbox +
// presence rooms open at boot and never close. So this is only re-read for
// rooms opened in a fresh process. The Settings copy tells the user to restart
// to apply a relay change. (The TURN server, by contrast, is per-RTCPeer-
// connection via buildIceOptions, so it does apply on the next pairing/session
// without a restart.)
export function userRelayConfig(): { urls: string[] } | undefined {
  const custom = useSettingsStore.getState().values.customRelayUrls
  return custom.length > 0 ? { urls: mergedRelayUrls(custom) } : undefined
}
