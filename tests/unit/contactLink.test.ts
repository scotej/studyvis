import * as ed from '@noble/ed25519'
import { x25519 } from '@noble/curves/ed25519.js'
import { beforeAll, describe, expect, test } from 'vitest'

import { signMessage } from '@/lib/crypto/identity'
import {
  buildContactCard,
  CONTACT_LINK_PREFIX,
  decodeContactLink,
  decodePairLink,
  encodeContactLink,
  generatePairingCode,
  encodePairLink,
  interpretImportText,
  parseContactCard,
  routeDeepLinkUrl,
} from '@/features/friends'
import { bytesToHex } from '@/lib/encoding'

let cardBytes: Uint8Array
let cardLink: string
let cardEdHex: string

beforeAll(async () => {
  const edPriv = new Uint8Array(32).fill(7)
  const xPriv = new Uint8Array(32).fill(11)
  cardEdHex = bytesToHex(ed.getPublicKey(edPriv))
  cardBytes = await buildContactCard(
    cardEdHex,
    bytesToHex(x25519.getPublicKey(xPriv)),
    'Río 🌊',
    (m) => Promise.resolve(signMessage(edPriv, m))
  )
  cardLink = encodeContactLink(cardBytes)
})

function decodesToCard(text: string): boolean {
  const bytes = decodeContactLink(text)
  if (!bytes) return false
  return Array.from(bytes).join(',') === Array.from(cardBytes).join(',')
}

describe('encodeContactLink / decodeContactLink', () => {
  test('round-trips exactly', () => {
    expect(cardLink.startsWith(CONTACT_LINK_PREFIX)).toBe(true)
    expect(decodesToCard(cardLink)).toBe(true)
  })

  test('preserves payload case (base64url is case-sensitive)', () => {
    // Lowercasing the payload would corrupt roughly half of real cards.
    expect(decodesToCard(cardLink.toLowerCase())).toBe(false)
  })

  test('tolerates surrounding chat text and wrappers', () => {
    expect(decodesToCard(`here's my code: ${cardLink} add me!`)).toBe(true)
    expect(decodesToCard(`<${cardLink}>`)).toBe(true)
    expect(decodesToCard(`(${cardLink})`)).toBe(true)
    expect(decodesToCard(`"${cardLink}"`)).toBe(true)
    expect(decodesToCard(`${cardLink}.`)).toBe(true)
    expect(decodesToCard(`\n  ${cardLink}\n`)).toBe(true)
  })

  test('case-insensitive scheme, tolerant of a trailing slash before #', () => {
    const payload = cardLink.slice(CONTACT_LINK_PREFIX.length)
    expect(decodesToCard(`STUDYVIS://ADD#${payload}`)).toBe(true)
    expect(decodesToCard(`studyvis://add/#${payload}`)).toBe(true)
  })

  test('recovers a payload split by an injected zero-width char', () => {
    const payload = cardLink.slice(CONTACT_LINK_PREFIX.length)
    const mid = Math.floor(payload.length / 2)
    const zwsp = '\u200B'
    const injected = `${CONTACT_LINK_PREFIX}${payload.slice(0, mid)}${zwsp}${payload.slice(mid)}`
    expect(decodesToCard(injected)).toBe(true)
  })

  test('rejects a legacy pair link and junk', () => {
    expect(decodeContactLink(encodePairLink(generatePairingCode()))).toBeNull()
    expect(decodeContactLink('https://example.com/#abc')).toBeNull()
    expect(decodeContactLink('')).toBeNull()
    expect(decodeContactLink('studyvis://add#')).toBeNull()
  })
})

describe('cross-scheme isolation', () => {
  test('decodePairLink rejects a contact link; decodeContactLink rejects a pair link; legacy still decodes', () => {
    const words = generatePairingCode()
    const pairLink = encodePairLink(words)
    expect(decodePairLink(cardLink)).toBeNull()
    expect(decodeContactLink(pairLink)).toBeNull()
    expect(decodePairLink(pairLink)).toEqual(words)
  })
})

describe('routeDeepLinkUrl', () => {
  test('classifies add, pair, and neither', () => {
    const words = generatePairingCode()
    const add = routeDeepLinkUrl(cardLink)
    expect(add?.kind).toBe('add')
    const pair = routeDeepLinkUrl(encodePairLink(words))
    expect(pair?.kind).toBe('pair')
    expect(routeDeepLinkUrl('studyvis://nope')).toBeNull()
  })

  test('a malformed card fragment does not shadow a leading legacy link', () => {
    const words = generatePairingCode()
    const combo = `${encodePairLink(words)} studyvis://add#XY`
    expect(routeDeepLinkUrl(combo)).toEqual({ kind: 'pair', words })
  })

  test('a lone malformed card link still routes to add (so the sheet explains)', () => {
    expect(routeDeepLinkUrl('studyvis://add#XY')?.kind).toBe('add')
  })
})

describe('interpretImportText', () => {
  test('a full contact link → contact', () => {
    const r = interpretImportText(cardLink)
    expect(r?.kind).toBe('contact')
    expect(r?.kind === 'contact' && parseContactCard(r.card).ok).toBe(true)
  })

  test('a bare base64url card (no prefix) → contact', () => {
    const bare = cardLink.slice(CONTACT_LINK_PREFIX.length)
    const r = interpretImportText(bare)
    expect(r?.kind).toBe('contact')
    expect(
      r?.kind === 'contact' &&
        Array.from(r.card).join(',') === Array.from(cardBytes).join(',')
    ).toBe(true)
  })

  test('a legacy pair link → legacy', () => {
    const words = generatePairingCode()
    expect(interpretImportText(encodePairLink(words))).toEqual({
      kind: 'legacy',
      words,
    })
  })

  test('bare 12 words → legacy', () => {
    const words = generatePairingCode()
    expect(interpretImportText(words.join(' '))).toEqual({
      kind: 'legacy',
      words,
    })
  })

  test('a malformed card fragment does not shadow a leading legacy link', () => {
    const words = generatePairingCode()
    const combo = `${encodePairLink(words)} studyvis://add#XY`
    expect(interpretImportText(combo)).toEqual({ kind: 'legacy', words })
  })

  test('unrelated text → null', () => {
    expect(interpretImportText('good luck on the exam')).toBeNull()
    expect(interpretImportText('')).toBeNull()
  })
})
