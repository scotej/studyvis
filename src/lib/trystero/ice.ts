import type { TurnServerConfig } from 'trystero'

import type { TurnPreference } from '@/stores/settingsStore'

// Public TURN servers for NAT traversal when a direct WebRTC connection can't
// form (symmetric / carrier-grade NAT, AP isolation, strict firewalls). These
// are network config, not design tokens, so they live here rather than in
// src/design/tokens.ts.
//
// PLAN.md §2 budgets for "public TURN", but the free, open-credential public
// TURN services that used to fill that role are gone. Verified dead on
// 2026-06-01: openrelay.metered.ca (the old `openrelayproject` endpoint)
// answers neither STUN Binding nor TURN Allocate on 80/443/3478, while
// Google/Cloudflare STUN respond fine from the same network. Metered migrated
// to per-account credentials; there is no reliable zero-config public TURN.
//
// So this ships EMPTY — pairing and sessions run STUN-only, which is exactly
// the prior behavior, so same-network pairing is unaffected. To enable
// cross-network connectivity, drop a TURN server here (self-hosted coturn, or a
// provider like Metered/Twilio/Cloudflare with its credentials). The wiring
// below consumes it the instant this list is non-empty — no other change:
//
//   { urls: ['turn:turn.example.net:3478', 'turns:turn.example.net:443'],
//     username: '…', credential: '…' }
export const PUBLIC_TURN_SERVERS: TurnServerConfig[] = []

export type IceOptions = {
  turnConfig?: TurnServerConfig[]
  rtcConfig?: RTCConfiguration
}

// Pure mapping of (preference, server list) → trystero ICE config; exported so
// the logic is testable independent of the shipped server list. With no TURN
// servers there is nothing to relay through, so every preference degrades to
// STUN-only — in particular 'always' (relay-only) is deliberately NOT honored,
// since forcing relay transport with zero relays guarantees a failed
// connection. We warn rather than silently discard that intent, so a user who
// set relay-only and a maintainer who shipped an empty list both have a thread
// to pull when connections fail.
export function iceOptionsFor(
  pref: TurnPreference,
  servers: TurnServerConfig[]
): IceOptions {
  if (servers.length === 0) {
    if (pref === 'always') {
      console.warn(
        "TURN preference 'always' (relay-only) ignored: no TURN servers are " +
          'configured, so forcing relay-only transport would guarantee a failed ' +
          'connection. Falling back to STUN-only. Configure PUBLIC_TURN_SERVERS ' +
          'in src/lib/trystero/ice.ts to honor this preference.'
      )
    }
    return {}
  }
  if (pref === 'never') return {}
  if (pref === 'always') {
    return { turnConfig: servers, rtcConfig: { iceTransportPolicy: 'relay' } }
  }
  return { turnConfig: servers }
}

// Translates the user's TURN preference (Settings → Network) into trystero ICE
// config against the configured TURN servers. Until now this preference was
// decorative — read by the UI, consumed by nothing. This is where it finally
// takes effect (the instant PUBLIC_TURN_SERVERS is non-empty):
// - 'auto'   : STUN first, public TURN as fallback when NAT/firewall blocks it.
// - 'always' : force relay-only (iceTransportPolicy 'relay') through TURN.
// - 'never'  : STUN only — no TURN, no relay fallback.
export function buildIceOptions(pref: TurnPreference): IceOptions {
  return iceOptionsFor(pref, PUBLIC_TURN_SERVERS)
}
