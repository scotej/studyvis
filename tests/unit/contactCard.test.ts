import * as ed from '@noble/ed25519'
import { x25519 } from '@noble/curves/ed25519.js'
import { describe, expect, test } from 'vitest'

// Importing identity first wires ed.hashes.sha512 (module side effect) so the
// synchronous ed helpers below work.
import { signMessage } from '@/lib/crypto/identity'
import {
  buildContactCard,
  CARD_VERSION,
  isSelfCard,
  NAME_CAP,
  parseContactCard,
  readContactCard,
  sanitizeDisplayName,
  verifyContactCard,
} from '@/features/friends/contactCard'
import { bytesToHex } from '@/lib/encoding'

type TestIdentity = {
  edPubHex: string
  xPubHex: string
  sign: (msg: Uint8Array) => Promise<Uint8Array>
}

function makeIdentity(seed: number): TestIdentity {
  const edPriv = new Uint8Array(32).fill(seed)
  const xPriv = new Uint8Array(32).fill(seed ^ 0x5a)
  const edPub = ed.getPublicKey(edPriv)
  const xPub = x25519.getPublicKey(xPriv)
  return {
    edPubHex: bytesToHex(edPub),
    xPubHex: bytesToHex(xPub),
    sign: (msg) => Promise.resolve(signMessage(edPriv, msg)),
  }
}

const alice = makeIdentity(1)
const bob = makeIdentity(2)

async function card(id: TestIdentity, name = 'Alice'): Promise<Uint8Array> {
  return buildContactCard(id.edPubHex, id.xPubHex, name, id.sign)
}

describe('contactCard build / parse / verify', () => {
  test('round-trips ed, x, and name', async () => {
    const bytes = await card(alice, 'Alice')
    const parsed = parseContactCard(bytes)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.card.version).toBe(CARD_VERSION)
    expect(parsed.card.edPubkey).toBe(alice.edPubHex)
    expect(parsed.card.xPubkey).toBe(alice.xPubHex)
    expect(parsed.card.name).toBe('Alice')
    expect(verifyContactCard(bytes)).toBe(true)
  })

  test('total length is exactly 130 + name_len', async () => {
    const bytes = await card(alice, 'Al')
    expect(bytes.length).toBe(130 + new TextEncoder().encode('Al').length)
  })

  test('empty name round-trips to empty string', async () => {
    const bytes = await card(alice, '')
    const parsed = parseContactCard(bytes)
    expect(parsed.ok && parsed.card.name).toBe('')
    expect(verifyContactCard(bytes)).toBe(true)
  })

  test('name with #, ://, base64 chars round-trips identical', async () => {
    const tricky = 'a#b://c-d_e+f=g'
    const bytes = await card(alice, tricky)
    const parsed = parseContactCard(bytes)
    expect(parsed.ok && parsed.card.name).toBe(tricky)
    expect(verifyContactCard(bytes)).toBe(true)
  })

  test('emoji name at the byte cap stays valid UTF-8', async () => {
    // 10 4-byte emoji = 40 bytes → truncated to <= 32 bytes = 8 emoji.
    const bytes = await card(alice, '😀'.repeat(10))
    const parsed = parseContactCard(bytes)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(
      new TextEncoder().encode(parsed.card.name).length
    ).toBeLessThanOrEqual(NAME_CAP)
    expect(parsed.card.name).not.toContain('�')
    expect(Array.from(parsed.card.name)).toEqual(Array.from('😀'.repeat(8)))
    expect(verifyContactCard(bytes)).toBe(true)
  })
})

describe('contactCard tamper detection', () => {
  test('flipping a name byte fails verification', async () => {
    const bytes = await card(alice, 'Alice')
    bytes[66] ^= 0xff // first name byte
    expect(verifyContactCard(bytes)).toBe(false)
  })

  test('flipping an x-key byte fails verification (x-only swap defense)', async () => {
    const bytes = await card(alice, 'Alice')
    bytes[40] ^= 0xff // inside the x25519 region (33..65)
    expect(verifyContactCard(bytes)).toBe(false)
  })

  test('flipping an ed-key byte fails verification', async () => {
    const bytes = await card(alice, 'Alice')
    bytes[5] ^= 0xff
    expect(verifyContactCard(bytes)).toBe(false)
  })

  test('flipping the version byte fails verification', async () => {
    const bytes = await card(alice, 'Alice')
    bytes[0] = 0x05 // version is inside the signed region → sig no longer matches
    expect(verifyContactCard(bytes)).toBe(false)
  })

  test('substituting a whole valid card for a different identity keeps its own sig', async () => {
    // A minted card (attacker signs their own keys) VERIFIES — the safety number
    // is the defense, not the signature. This documents that intended property.
    const mint = await card(bob, 'Alice')
    expect(verifyContactCard(mint)).toBe(true)
    const parsed = parseContactCard(mint)
    expect(parsed.ok && parsed.card.edPubkey).toBe(bob.edPubHex)
  })
})

describe('contactCard structural rejects', () => {
  test('too-short buffer rejects without indexing past the end', () => {
    expect(parseContactCard(new Uint8Array(40)).ok).toBe(false)
    expect(verifyContactCard(new Uint8Array(40))).toBe(false)
  })

  test('a trailing extra byte rejects (exact-length rule)', async () => {
    const bytes = await card(alice, 'Alice')
    const longer = new Uint8Array(bytes.length + 1)
    longer.set(bytes, 0)
    expect(parseContactCard(longer).ok).toBe(false)
  })

  test('a missing signature byte rejects', async () => {
    const bytes = await card(alice, 'Alice')
    expect(parseContactCard(bytes.slice(0, bytes.length - 1)).ok).toBe(false)
  })

  test('name_len over the cap rejects even if length is self-consistent', () => {
    const bytes = new Uint8Array(130 + 33)
    bytes[0] = CARD_VERSION
    bytes[1] = 1 // non-zero ed
    bytes[33] = 1 // non-zero x
    bytes[65] = 33 // > NAME_CAP
    expect(parseContactCard(bytes).ok).toBe(false)
  })

  test('all-zero ed or x key rejects', async () => {
    const bytes = await card(alice, 'Alice')
    const zeroEd = bytes.slice()
    zeroEd.fill(0, 1, 33)
    expect(parseContactCard(zeroEd).ok).toBe(false)
    const zeroX = bytes.slice()
    zeroX.fill(0, 33, 65)
    expect(parseContactCard(zeroX).ok).toBe(false)
  })

  test('version gating: 0x03+ is future-version, 0x00/0x01 corrupt', () => {
    const mk = (v: number) => {
      const b = new Uint8Array(130)
      b[0] = v
      b[1] = 1
      b[33] = 1
      b[65] = 0
      return b
    }
    expect(parseContactCard(mk(0x03))).toEqual({
      ok: false,
      reason: 'future-version',
    })
    expect(parseContactCard(mk(0xff))).toEqual({
      ok: false,
      reason: 'future-version',
    })
    expect(parseContactCard(mk(0x00))).toEqual({ ok: false, reason: 'corrupt' })
    expect(parseContactCard(mk(0x01))).toEqual({ ok: false, reason: 'corrupt' })
  })

  test('invalid UTF-8 in the name region rejects', () => {
    // Structurally-valid frame (130 + name_len(1)) whose name is a lone UTF-8
    // continuation byte, so the fatal decoder rejects it.
    const framed = new Uint8Array(131)
    framed[0] = CARD_VERSION
    framed[1] = 1
    framed[33] = 1
    framed[65] = 1
    framed[66] = 0x80 // lone UTF-8 continuation byte → invalid
    expect(parseContactCard(framed).ok).toBe(false)
  })
})

describe('readContactCard (parse → verify → self)', () => {
  test('a friend card is ok and not self', async () => {
    const bytes = await card(bob, 'Bob')
    const res = readContactCard(bytes, alice.edPubHex)
    expect(res).toEqual({
      ok: true,
      card: expect.objectContaining({ edPubkey: bob.edPubHex }),
      isSelf: false,
    })
  })

  test('own card is flagged isSelf', async () => {
    const bytes = await card(alice, 'Alice')
    const res = readContactCard(bytes, alice.edPubHex)
    expect(res.ok && res.isSelf).toBe(true)
  })

  test('a tampered card reports tampered before any card data', async () => {
    const bytes = await card(bob, 'Bob')
    bytes[70] ^= 0xff
    expect(readContactCard(bytes, alice.edPubHex)).toEqual({
      ok: false,
      reason: 'tampered',
    })
  })
})

describe('isSelfCard / sanitizeDisplayName', () => {
  test('isSelfCard is case-insensitive on hex', () => {
    expect(isSelfCard('ABCD', 'abcd')).toBe(true)
    expect(isSelfCard('abcd', 'ef01')).toBe(false)
  })

  test('sanitizeDisplayName strips bidi/zero-width and NFC-normalizes', () => {
    expect(sanitizeDisplayName('\u202Eevil\u202C')).toBe('evil')
    expect(sanitizeDisplayName('a\u200Bb')).toBe('ab')
    // LRM/RLM (the bidi-reorder spoof the fn targets) are stripped.
    expect(sanitizeDisplayName('a\u200Eb\u200Fc')).toBe('abc')
  })

  test('sanitizeDisplayName keeps ZWJ so emoji sequences survive', () => {
    const family = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}'
    expect(sanitizeDisplayName(family)).toBe(family)
  })
})
