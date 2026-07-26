// I74 — pure relay-presence event helpers: NIP-01 event construction and the
// sealed payload envelope. The pool and presence integration are covered in
// nostr-pool.test.ts / presence.test.ts.

import { describe, expect, test } from 'vitest'
import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'

import {
  buildPresenceEvent,
  createThrowawaySigner,
  openPresencePayload,
  PRESENCE_EVENT_KIND,
  sealPresencePayload,
} from '@/lib/nostr/events'
import { presenceRelayKey } from '@/lib/crypto/topics'
import { generateIdentity } from '@/lib/crypto/identity'
import { bytesToHex, hexToBytes } from '@/lib/encoding'

const encoder = new TextEncoder()

describe('buildPresenceEvent', () => {
  test('produces a valid NIP-01 event (id and schnorr sig verify)', () => {
    const signer = createThrowawaySigner()
    const event = buildPresenceEvent(signer, 'tag-value', 'content', 1_700_000)

    expect(event.kind).toBe(PRESENCE_EVENT_KIND)
    expect(event.tags).toEqual([['x', 'tag-value']])
    expect(event.created_at).toBe(1_700_000)
    expect(event.pubkey).toBe(signer.pubkeyHex)

    const recomputedId = bytesToHex(
      sha256(
        encoder.encode(
          JSON.stringify([
            0,
            event.pubkey,
            event.created_at,
            event.kind,
            event.tags,
            event.content,
          ])
        )
      )
    )
    expect(event.id).toBe(recomputedId)
    expect(
      schnorr.verify(
        hexToBytes(event.sig),
        hexToBytes(event.id),
        hexToBytes(event.pubkey)
      )
    ).toBe(true)
  })

  test('signers are throwaway: two runs never share a pubkey', () => {
    expect(createThrowawaySigner().pubkeyHex).not.toBe(
      createThrowawaySigner().pubkeyHex
    )
  })
})

describe('sealed presence payload', () => {
  const key = presenceRelayKey(generateIdentity().edPub)

  test('heartbeat and goodbye round-trip under the derived key', () => {
    expect(
      openPresencePayload(key, sealPresencePayload(key, { v: 1 }))
    ).toEqual({ v: 1 })
    expect(
      openPresencePayload(
        key,
        sealPresencePayload(key, { v: 1, leaving: true })
      )
    ).toEqual({ v: 1, leaving: true })
  })

  test('a payload sealed for a different pubkey does not open', () => {
    const otherKey = presenceRelayKey(generateIdentity().edPub)
    const sealed = sealPresencePayload(otherKey, { v: 1 })
    expect(openPresencePayload(key, sealed)).toBeNull()
  })

  test('garbage, truncated, and tampered content are all rejected', () => {
    expect(openPresencePayload(key, 'not base64 !!!')).toBeNull()
    expect(openPresencePayload(key, '')).toBeNull()
    expect(openPresencePayload(key, 'AAAA')).toBeNull() // < nonce length
    const sealed = sealPresencePayload(key, { v: 1 })
    const tampered =
      sealed.slice(0, -4) + (sealed.endsWith('AAA=') ? 'BBB=' : 'AAA=')
    expect(openPresencePayload(key, tampered)).toBeNull()
  })

  test('nonces are fresh per seal (no deterministic ciphertext)', () => {
    expect(sealPresencePayload(key, { v: 1 })).not.toBe(
      sealPresencePayload(key, { v: 1 })
    )
  })
})

// The presenceRelayTag/presenceRelayKey derivations are regression-pinned in
// topics.test.ts alongside the sibling rendezvous contracts.
