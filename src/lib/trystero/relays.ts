import { useSettingsStore } from '@/stores/settingsStore'

export { DEFAULT_RELAY_URLS } from './relayUrls'
import { DEFAULT_RELAY_URLS } from './relayUrls'

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
// to apply a relay change. (The TURN server via buildIceOptions is captured
// per room-join, so it applies to the next pairing/session/invite send without
// a restart — but the always-on inbox + presence rooms only pick up a TURN
// change on relaunch, same as relays.)
export function userRelayConfig(): { urls: string[] } | undefined {
  const custom = useSettingsStore.getState().values.customRelayUrls
  return custom.length > 0 ? { urls: mergedRelayUrls(custom) } : undefined
}
