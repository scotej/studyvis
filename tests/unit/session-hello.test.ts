import { describe, expect, test } from 'vitest'

import {
  HELLO_NAME_CAP,
  HELLO_VERSION,
  serializeHelloForSig,
  validateHelloPayload,
  type HelloPayload,
} from '@/features/session/hello'
import {
  bytesToHex,
  generateIdentity,
  signMessage,
  type Identity,
} from '@/lib/crypto/identity'

const PEER_ID = 'peer-1'

function makeHello(displayName: string): HelloPayload {
  const identity = generateIdentity()
  const core = {
    v: HELLO_VERSION,
    peer_id: PEER_ID,
    ed_pubkey_hex: bytesToHex(identity.edPub),
    display_name: displayName,
    joined_at: 1,
  }
  const sig = signMessage(identity.edPriv, serializeHelloForSig(core))
  return { ...core, sig: bytesToHex(sig) }
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length
}

describe('session hello display_name normalization (item 35)', () => {
  test('bounds an oversized name without breaking verification', () => {
    const hello = makeHello('A'.repeat(10_240))
    const validated = validateHelloPayload(hello, PEER_ID)
    expect(validated).not.toBeNull()
    expect(byteLength(validated!.display_name)).toBeLessThanOrEqual(
      HELLO_NAME_CAP
    )
  })

  test('strips a bidi override without breaking verification', () => {
    const hello = makeHello('Sam‮gro')
    const validated = validateHelloPayload(hello, PEER_ID)
    expect(validated?.display_name).toBe('Samgro')
  })

  test('leaves a legitimate 40-char name untouched', () => {
    const name = 'Alexandra From The Tuesday Study Group x'
    expect(name).toHaveLength(40)
    const validated = validateHelloPayload(makeHello(name), PEER_ID)
    expect(validated?.display_name).toBe(name)
  })
})

// Signs a hello for `identity`, then layers `overrides` on top AFTER signing —
// so an override tampers a field the signature already covers, which is what
// the negative cases below need.
function signHello(
  identity: Identity,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  const core = {
    v: HELLO_VERSION,
    peer_id: PEER_ID,
    ed_pubkey_hex: bytesToHex(identity.edPub),
    display_name: 'Sam',
    joined_at: 1000,
  }
  const payload: HelloPayload = {
    ...core,
    sig: bytesToHex(signMessage(identity.edPriv, serializeHelloForSig(core))),
  }
  return { ...payload, ...overrides }
}

describe('validateHelloPayload (peerId ↔ ed_pubkey gate)', () => {
  test('a well-formed hello yields exactly the three bound fields', () => {
    const sam = generateIdentity()
    expect(validateHelloPayload(signHello(sam), PEER_ID)).toEqual({
      ed_pubkey_hex: bytesToHex(sam.edPub),
      display_name: 'Sam',
      joined_at: 1000,
    })
  })

  test('rejects a payload whose peer_id ≠ the wire sender (impersonation)', () => {
    const sam = generateIdentity()
    expect(validateHelloPayload(signHello(sam), 'someone-else')).toBeNull()
  })

  test('rejects a payload claiming another identity’s pubkey', () => {
    const sam = generateIdentity()
    const mallory = generateIdentity()
    expect(
      validateHelloPayload(
        signHello(sam, { ed_pubkey_hex: bytesToHex(mallory.edPub) }),
        PEER_ID
      )
    ).toBeNull()
  })

  test('rejects a tampered display_name or joined_at (sig covers both)', () => {
    const sam = generateIdentity()
    expect(
      validateHelloPayload(signHello(sam, { display_name: 'Mallory' }), PEER_ID)
    ).toBeNull()
    expect(
      validateHelloPayload(signHello(sam, { joined_at: 999 }), PEER_ID)
    ).toBeNull()
  })

  test('rejects malformed shapes before it ever verifies', () => {
    const sam = generateIdentity()
    // Wrong version, a hello with no sig field at all, non-hex key, 31-byte
    // key, 63-byte sig, and null: each trips a shape/length gate ahead of the
    // signature check.
    expect(validateHelloPayload(signHello(sam, { v: 2 }), PEER_ID)).toBeNull()
    expect(
      validateHelloPayload(
        {
          v: HELLO_VERSION,
          peer_id: PEER_ID,
          ed_pubkey_hex: bytesToHex(sam.edPub),
          display_name: 'Sam',
          joined_at: 1000,
        },
        PEER_ID
      )
    ).toBeNull()
    expect(
      validateHelloPayload(
        signHello(sam, { ed_pubkey_hex: 'zz'.repeat(32) }),
        PEER_ID
      )
    ).toBeNull()
    expect(
      validateHelloPayload(
        signHello(sam, { ed_pubkey_hex: 'ab'.repeat(31) }),
        PEER_ID
      )
    ).toBeNull()
    expect(
      validateHelloPayload(signHello(sam, { sig: 'ab'.repeat(63) }), PEER_ID)
    ).toBeNull()
    expect(validateHelloPayload(null, PEER_ID)).toBeNull()
  })
})

describe('serializeHelloForSig (cross-version canonical bytes)', () => {
  test('pins the exact key order and JSON layout', () => {
    // A failure here means the hello wire format changed: every already-
    // installed build verifies against these bytes, so a serialization edit
    // strands them silently (peers see each other but record no binding). This
    // is a tripwire — reckon with the compat break, do not "fix" the vector.
    const bytes = serializeHelloForSig({
      v: HELLO_VERSION,
      peer_id: 'p1',
      ed_pubkey_hex: 'ab',
      display_name: 'Sam',
      joined_at: 1,
    })
    expect(new TextDecoder().decode(bytes)).toBe(
      '{"v":1,"peer_id":"p1","ed_pubkey_hex":"ab","display_name":"Sam","joined_at":1}'
    )
  })
})
