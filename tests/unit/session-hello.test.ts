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
