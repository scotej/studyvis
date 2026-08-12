// Canonical codec for the optional per-peer overlap durations stored on a
// sessions row. NULL is a compatibility sentinel (duration precision was not
// recorded); an empty object is a precise, peerless session.

// Lowercase only: two spellings of one identity would otherwise split its
// accumulated overlap across distinct object keys.
const ED25519_HEX = /^[0-9a-f]{64}$/

export type PeerPresenceMs = ReadonlyMap<string, number>

function entriesOf(
  presence: PeerPresenceMs | Readonly<Record<string, number>>
): [string, number][] {
  return presence instanceof Map
    ? Array.from(presence.entries())
    : Object.entries(presence)
}

function validEntry(key: string, value: unknown): value is number {
  return (
    ED25519_HEX.test(key) &&
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0
  )
}

export function encodePeerPresenceMs(
  presence: PeerPresenceMs | Readonly<Record<string, number>>
): string {
  const entries = entriesOf(presence)
  for (const [key, value] of entries) {
    if (!validEntry(key, value)) {
      throw new TypeError(
        'peer presence must contain Ed25519 keys and non-negative integer ms'
      )
    }
  }
  // Code-unit comparison is locale-independent, so persisted key order does
  // not depend on the runtime locale.
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return JSON.stringify(Object.fromEntries(entries))
}

export function decodePeerPresenceMs(
  raw: string | null | undefined
): Map<string, number> | null {
  if (raw == null) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null
    }
    const out = new Map<string, number>()
    for (const [key, value] of Object.entries(parsed)) {
      if (!validEntry(key, value)) return null
      out.set(key, value)
    }
    // Canonical bytes are part of the storage contract, not just a writer
    // preference. Re-encoding catches whitespace, unsorted/duplicate keys,
    // exponent notation and other semantically valid but ambiguous forms.
    if (encodePeerPresenceMs(out) !== raw) return null
    return out
  } catch {
    return null
  }
}

// A presence map is authoritative only when it accounts for exactly the same
// authenticated participants as peer_pubkeys. Partial/corrupt maps fall back
// to the legacy whole-session interpretation instead of silently undercounting.
export function decodePeerPresenceMsForPeers(
  raw: string | null | undefined,
  peerPubkeys: readonly string[]
): Map<string, number> | null {
  const decoded = decodePeerPresenceMs(raw)
  if (decoded === null) return null
  const peers = new Set(peerPubkeys)
  if (decoded.size !== peers.size) return null
  for (const peer of peers) {
    if (!decoded.has(peer)) return null
  }
  return decoded
}

// The largest individual overlap in a canonical map. This is useful when a
// legacy row has precise partner timing but only whole study minutes: a later
// rejoin must never synthesize a logical session shorter than one of the
// overlaps it already records.
export function maxPeerPresenceMs(
  raw: string | null | undefined
): number | null {
  const decoded = decodePeerPresenceMs(raw)
  if (decoded === null) return null
  let max = 0
  for (const durationMs of decoded.values()) {
    max = Math.max(max, durationMs)
  }
  return max
}

// A participant can overlap the local session for at most the local session's
// duration. Cap only canonical maps; unknown/malformed legacy data remains
// unknown rather than being partially repaired into a misleading precision
// claim.
export function capPeerPresenceMs(
  raw: string | null | undefined,
  maximumMs: number
): string | null {
  if (!Number.isSafeInteger(maximumMs) || maximumMs < 0) return null
  const decoded = decodePeerPresenceMs(raw)
  if (decoded === null) return null
  return encodePeerPresenceMs(
    new Map(
      Array.from(decoded, ([peer, durationMs]) => [
        peer,
        Math.min(durationMs, maximumMs),
      ])
    )
  )
}

// Used when another stint re-enters the same topic-keyed logical session.
// Unknown precision is contagious: adding a precisely measured tail to a
// legacy/invalid head cannot make the whole row precise.
export function mergePeerPresenceMs(
  priorRaw: string | null | undefined,
  stintRaw: string
): string | null {
  const prior = decodePeerPresenceMs(priorRaw)
  const stint = decodePeerPresenceMs(stintRaw)
  if (prior === null || stint === null) return null

  const merged = new Map(prior)
  for (const [peer, durationMs] of stint) {
    const next = (merged.get(peer) ?? 0) + durationMs
    if (!Number.isSafeInteger(next)) return null
    merged.set(peer, next)
  }
  return encodePeerPresenceMs(merged)
}
