// I74 — pure helpers for the relay-presence leg: building signed ephemeral
// Nostr events and sealing/opening their payloads. No sockets here (that's
// ./pool); everything in this file is deterministic given its inputs, so it
// unit-tests in node without any network seam.
//
// Protocol notes, mirrored from scripts/check-relays.ts (the shipped relay
// list is verified against exactly this shape at every release):
// - Kind 20001 sits in NIP-01's ephemeral range (20000–29999): relays
//   broadcast to live subscribers and never store, which matches heartbeat
//   semantics (a heartbeat that wasn't heard live is worthless).
// - The single-letter `x` tag is relay-indexable, so a `#x` filter narrows
//   the subscription to our derived presence tags server-side.
// - Events are schnorr-signed with a THROWAWAY secp256k1 key minted per app
//   run: Nostr relays require a valid signature to accept a publish, but the
//   key is deliberately no identity — a stable signing key would hand relay
//   observers a linkable pseudonym across topics (trystero mints its announce
//   key per page load for the same reason). Receivers do NOT verify it;
//   validity comes from the Poly1305 tag under the pubkey-derived seal key.
// - `created_at` uses the sender clock because the wire shape requires it,
//   but receivers never read it: no `since` filter, no created_at checks.
//   Trystero's `since: now()` announce filter is exactly how a clock-skewed
//   peer became invisible forever (#47 C1) — the relay leg must not
//   reintroduce that class of bug.

import { xsalsa20poly1305 } from '@noble/ciphers/salsa.js'
import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'

import { base64ToBytes, bytesToBase64, bytesToHex } from '@/lib/encoding'

export const PRESENCE_EVENT_KIND = 20001

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export type NostrEvent = {
  id: string
  pubkey: string
  created_at: number
  kind: number
  tags: string[][]
  content: string
  sig: string
}

export type NostrSigner = {
  pubkeyHex: string
  sign: (eventIdBytes: Uint8Array) => Uint8Array
}

// One throwaway signing key per call site (in practice: per app run).
export function createThrowawaySigner(): NostrSigner {
  const priv = crypto.getRandomValues(new Uint8Array(32))
  const pubkeyHex = bytesToHex(schnorr.getPublicKey(priv))
  return {
    pubkeyHex,
    sign: (eventIdBytes) => schnorr.sign(eventIdBytes, priv),
  }
}

// NIP-01 event id: sha256 over the canonical JSON array serialization.
export function buildPresenceEvent(
  signer: NostrSigner,
  tagValue: string,
  content: string,
  createdAtSec: number
): NostrEvent {
  const tags = [['x', tagValue]]
  const serialized = JSON.stringify([
    0,
    signer.pubkeyHex,
    createdAtSec,
    PRESENCE_EVENT_KIND,
    tags,
    content,
  ])
  const idBytes = sha256(encoder.encode(serialized))
  const id = bytesToHex(idBytes)
  return {
    id,
    pubkey: signer.pubkeyHex,
    created_at: createdAtSec,
    kind: PRESENCE_EVENT_KIND,
    tags,
    content,
    sig: bytesToHex(signer.sign(idBytes)),
  }
}

// Wire payload inside the sealed content. `leaving` mirrors the datachannel
// goodbye (F7): a goodbye flips the friend offline immediately instead of
// aging out over the 60s window. No timestamp field on purpose — receivers
// stamp arrival with their OWN clock (see presence.ts).
export type RelayPresencePayload = { v: 1; leaving?: true }

// content = base64(nonce[24] || xsalsa20poly1305(key, nonce, json)).
// Poly1305 doubles as the validity check: a payload that doesn't open under
// the friend's derived key is silently dropped, whatever relay it rode in on.
export function sealPresencePayload(
  key: Uint8Array,
  payload: RelayPresencePayload
): string {
  const nonce = crypto.getRandomValues(new Uint8Array(24))
  const plaintext = encoder.encode(JSON.stringify(payload))
  const ciphertext = xsalsa20poly1305(key, nonce).encrypt(plaintext)
  const packed = new Uint8Array(nonce.length + ciphertext.length)
  packed.set(nonce, 0)
  packed.set(ciphertext, nonce.length)
  return bytesToBase64(packed)
}

export function openPresencePayload(
  key: Uint8Array,
  content: string
): RelayPresencePayload | null {
  let packed: Uint8Array
  try {
    packed = base64ToBytes(content)
  } catch {
    return null
  }
  if (packed.length <= 24) return null
  const nonce = packed.slice(0, 24)
  const ciphertext = packed.slice(24)
  let plaintext: Uint8Array
  try {
    plaintext = xsalsa20poly1305(key, nonce).decrypt(ciphertext)
  } catch {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(decoder.decode(plaintext))
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const candidate = parsed as { v?: unknown; leaving?: unknown }
  if (candidate.v !== 1) return null
  if (candidate.leaving !== undefined && candidate.leaving !== true) return null
  return candidate.leaving === true ? { v: 1, leaving: true } : { v: 1 }
}
