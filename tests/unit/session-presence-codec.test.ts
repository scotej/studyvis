import { describe, expect, test } from 'vitest'

import {
  decodePeerPresenceMs,
  decodePeerPresenceMsForPeers,
  encodePeerPresenceMs,
  capPeerPresenceMs,
  maxPeerPresenceMs,
  mergePeerPresenceMs,
} from '@/lib/db/sessionPresence'

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)

describe('session peer-presence codec', () => {
  test('encodes a deterministic sorted compact object, including empty', () => {
    expect(encodePeerPresenceMs(new Map())).toBe('{}')
    expect(
      encodePeerPresenceMs(
        new Map([
          [B, 2],
          [A, 1],
        ])
      )
    ).toBe(`{"${A}":1,"${B}":2}`)
  })

  test('round-trips zero and non-zero safe integer durations', () => {
    expect(
      Array.from(decodePeerPresenceMs(`{"${A}":0,"${B}":1234}`) ?? [])
    ).toEqual([
      [A, 0],
      [B, 1234],
    ])
  })

  test.each([
    null,
    undefined,
    '',
    'not-json',
    'null',
    '[]',
    `{"short":1}`,
    `{"${A}":-1}`,
    `{"${A}":1.5}`,
    `{"${A}":${Number.MAX_SAFE_INTEGER + 1}}`,
    `{"${A}":"1"}`,
  ])('treats an invalid or unknown payload as absent: %s', (raw) => {
    expect(decodePeerPresenceMs(raw)).toBeNull()
  })

  test.each([
    ` {"${A}":1}`,
    `{"${A}":1, "${B}":2}`,
    `{"${B}":2,"${A}":1}`,
    `{"${A}":1,"${A}":2}`,
  ])('rejects non-canonical JSON bytes: %s', (raw) => {
    expect(decodePeerPresenceMs(raw)).toBeNull()
  })

  test('encoder rejects invalid keys and values rather than writing ambiguity', () => {
    expect(() => encodePeerPresenceMs({ short: 1 })).toThrow(TypeError)
    expect(() => encodePeerPresenceMs({ [A.toUpperCase()]: 1 })).toThrow(
      TypeError
    )
    expect(() => encodePeerPresenceMs({ [A]: -1 })).toThrow(TypeError)
    expect(() => encodePeerPresenceMs({ [A]: 1.5 })).toThrow(TypeError)
    expect(decodePeerPresenceMs(`{"${A.toUpperCase()}":1}`)).toBeNull()
  })

  test('requires an exact keyset before stats treats a map as authoritative', () => {
    const raw = encodePeerPresenceMs({ [A]: 60_000 })
    expect(decodePeerPresenceMsForPeers(raw, [A])?.get(A)).toBe(60_000)
    expect(decodePeerPresenceMsForPeers(raw, [A, B])).toBeNull()
    expect(decodePeerPresenceMsForPeers(raw, [])).toBeNull()
    expect(decodePeerPresenceMsForPeers('{}', [])).toEqual(new Map())
  })

  test('merges per-peer durations and preserves unknown precision', () => {
    const prior = encodePeerPresenceMs({ [A]: 20_000, [B]: 5_000 })
    const stint = encodePeerPresenceMs({ [A]: 30_000 })
    expect(mergePeerPresenceMs(prior, stint)).toBe(
      encodePeerPresenceMs({ [A]: 50_000, [B]: 5_000 })
    )
    expect(mergePeerPresenceMs(null, stint)).toBeNull()
    expect(mergePeerPresenceMs('malformed', stint)).toBeNull()
  })

  test('bounds canonical peer overlap by the logical study duration', () => {
    const raw = encodePeerPresenceMs({ [A]: 90_000, [B]: 30_000 })
    expect(maxPeerPresenceMs(raw)).toBe(90_000)
    expect(capPeerPresenceMs(raw, 60_000)).toBe(
      encodePeerPresenceMs({ [A]: 60_000, [B]: 30_000 })
    )
    expect(capPeerPresenceMs('malformed', 60_000)).toBeNull()
    expect(capPeerPresenceMs(raw, -1)).toBeNull()
  })

  test('overflow during a merge degrades to unknown', () => {
    const prior = encodePeerPresenceMs({ [A]: Number.MAX_SAFE_INTEGER })
    const stint = encodePeerPresenceMs({ [A]: 1 })
    expect(mergePeerPresenceMs(prior, stint)).toBeNull()
  })
})
