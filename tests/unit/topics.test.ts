import { describe, expect, test } from 'vitest'

import {
  inboxTopic,
  inboxPassword,
  pairTopic,
  pairPassword,
  sessionTopic,
  presenceTopic,
  presencePassword,
} from '@/lib/crypto/topics'
import { buildPairAuthMessage } from '@/features/friends/pair'
import { bytesToHex } from '@/lib/encoding'

// Fixtures. A faithful 12-word pairing code (PAIR_ENTROPY_BITS = 128 →
// 12 words); pairTopic/pairPassword accept any string[], so if the entropy
// ever changes this stays a valid pinned INPUT even if it stops mirroring
// production shape.
const ED = new Uint8Array(32).fill(0x11)
const SID = new Uint8Array(32).fill(0x22)
const WORDS = [
  'abandon',
  'ability',
  'able',
  'about',
  'above',
  'absent',
  'absorb',
  'abstract',
  'absurd',
  'abuse',
  'access',
  'accident',
]

// Six PEER-BINDING derivations. Both sides derive these independently from
// public inputs (a friend's ed pubkey, or the shared pairing words), so two
// builds meet only if they compute the identical string. Changing one of these
// values is the mistake this test exists to catch — bump the :v1: suffix and
// coordinate both sides instead. (Same toll migrations.rs pays on its shipped
// hashes.)
describe('rendezvous derivations (peer-binding wire contract)', () => {
  test('inboxTopic is pinned', () => {
    expect(inboxTopic(ED)).toBe(
      '29c0edc7ddca7894b1a92ad972012bb50ffff9b9ec620645970b556140e09bdd'
    )
  })

  test('inboxPassword is pinned', () => {
    expect(inboxPassword(ED)).toBe(
      'cfe265aca89c1f7d0742ec13926954f350675f196a4a23d7d52d9a10feb647cd'
    )
  })

  test('pairTopic is pinned', () => {
    expect(pairTopic(WORDS)).toBe(
      '52d682f043200ba25dc0df07973505b595de5aeb699047898f710900eb7201b5'
    )
  })

  test('pairPassword is pinned', () => {
    expect(pairPassword(WORDS)).toBe(
      'e513d508c5b4fcbbb37f7be47847988119b91becd48e24c3e9e952e0e748b516'
    )
  })

  test('presenceTopic is pinned', () => {
    expect(presenceTopic(ED)).toBe(
      'c05a65b131be1ced947bb7b4f04f5f5fdb180e7617a3f09e551518de68353ac2'
    )
  })

  test('presencePassword is pinned', () => {
    expect(presencePassword(ED)).toBe(
      '87c7d66c0a9ebf9643400fda0a13f2e710da662ae2ea5ce76fb3d948cc9f4bfd'
    )
  })

  test('the four ed-keyed derivations are pairwise distinct', () => {
    // They hash an IDENTICAL base64 payload (the same ed pubkey) and differ
    // only by label, so a copy-pasted label — collapsing presence onto inbox —
    // is exactly the collision this catches.
    const values = [
      inboxTopic(ED),
      inboxPassword(ED),
      presenceTopic(ED),
      presencePassword(ED),
    ]
    expect(new Set(values).size).toBe(values.length)
  })

  test('pairTopic and pairPassword differ within the words family', () => {
    expect(pairTopic(WORDS)).not.toBe(pairPassword(WORDS))
  })
})

// sessionTopic is pinned for stability / collision hygiene ONLY — NOT a
// rendezvous contract. The host generates it from local random bytes and
// TRANSMITS it as InvitePayload.session_topic; the guest joins the received
// string verbatim (createGuestRoom) and never re-derives, so a changed
// derivation still meets an older guest. Freely changeable — this vector just
// documents the current mapping.
describe('sessionTopic (host-generated, transmitted — not a rendezvous contract)', () => {
  test('sessionTopic is pinned', () => {
    expect(sessionTopic(SID)).toBe(
      'bbb9651a9cd4c7ca904941fa3809c193370f0be91d8166e5b25c1e266b87e3a1'
    )
  })
})

// Cross-version SIGNING contract: the exact bytes both sides feed to
// sign/verify during pairing. Exercised only symmetrically by pair.test.ts, so
// an in-place change to the concatenation order or joiner passes every gate yet
// strands already-installed builds. Pinned here to make that change loud.
describe('buildPairAuthMessage (pairing signature bytes)', () => {
  test('is pinned for (WORDS, 11*32, 22*32)', () => {
    expect(
      bytesToHex(buildPairAuthMessage(WORDS, '11'.repeat(32), '22'.repeat(32)))
    ).toBe(
      '6162616e646f6e2d6162696c6974792d61626c652d61626f75742d61626f76652d616273656e742d6162736f72622d61627374726163742d6162737572642d61627573652d6163636573732d6163636964656e743131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313132323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232'
    )
  })
})
