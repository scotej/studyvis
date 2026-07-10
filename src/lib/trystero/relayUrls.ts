// #47 C4 — alias-free home for the pinned relay list so scripts/check-relays.ts
// (type-checked under tsconfig.node.json, which has no `@/*` paths) can import
// it directly. App code keeps importing from ./relays, which re-exports.

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
// every entry below passed `npm run check-relays` (#47 C4 — the scripted
// ephemeral-event round-trip; release-prep also runs it as a non-blocking
// warning) on 2026-07-10. Re-verify before trusting a stale list and drop
// any that go dark — relay.damus.io and relay.froth.zone were unreachable at
// the original 2026-06-01 verification and are deliberately omitted despite
// being in trystero's default pool.
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
