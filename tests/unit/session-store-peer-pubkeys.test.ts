// #210 data contract: cumulative membership survives live-peer pruning while
// authenticated overlap counts only intervals in which that identity was
// actually present.

import { afterEach, expect, test } from 'vitest'

import { useSessionStore } from '@/stores/sessionStore'

afterEach(() => {
  useSessionStore.getState().reset()
})

const ED_A = 'aa'.repeat(32)
const ED_B = 'bb'.repeat(32)
const MINUTE = 60_000

test('collectPeerPubkeys survives peerLeft pruning the live peers map', () => {
  const s = useSessionStore.getState()
  s.peerJoined('peer-a')
  s.setPeerHello('peer-a', {
    ed_pubkey_hex: ED_A,
    display_name: 'A',
    joined_at: 1,
  })
  s.peerJoined('peer-b')
  s.setPeerHello('peer-b', {
    ed_pubkey_hex: ED_B,
    display_name: 'B',
    joined_at: 2,
  })

  // Both peers leave and the local participant continues studying solo.
  s.peerLeft('peer-a')
  s.peerLeft('peer-b')
  expect(Object.keys(useSessionStore.getState().peers)).toHaveLength(0)

  // Cumulative set still has both, sorted + JSON-encoded.
  expect(useSessionStore.getState().collectPeerPubkeys()).toBe(
    JSON.stringify([ED_A, ED_B].sort())
  )
  expect(useSessionStore.getState().seenPeerEdPubkeys).toEqual([ED_A, ED_B])
})

test('reset clears the cumulative set so pubkeys do not leak across sessions', () => {
  const s = useSessionStore.getState()
  s.setPeerHello('peer-a', {
    ed_pubkey_hex: ED_A,
    display_name: 'A',
    joined_at: 1,
  })
  expect(useSessionStore.getState().collectPeerPubkeys()).not.toBeNull()
  useSessionStore.getState().reset()
  expect(useSessionStore.getState().collectPeerPubkeys()).toBeNull()
  expect(useSessionStore.getState().seenPeerEdPubkeys).toEqual([])
  expect(useSessionStore.getState().peerPresence).toEqual({})
})

test('setPeerHello dedupes a repeated pubkey (reconnect under a new peerId)', () => {
  const s = useSessionStore.getState()
  s.setPeerHello('peer-a', {
    ed_pubkey_hex: ED_A,
    display_name: 'A',
    joined_at: 1,
  })
  s.setPeerHello('peer-a2', {
    ed_pubkey_hex: ED_A,
    display_name: 'A',
    joined_at: 3,
  })
  expect(useSessionStore.getState().seenPeerEdPubkeys).toEqual([ED_A])
})

test('30 minutes together plus 90 minutes solo records 30 peer minutes', () => {
  const s = useSessionStore.getState()
  s.peerJoined('peer-a')
  s.setPeerHello(
    'peer-a',
    { ed_pubkey_hex: ED_A, display_name: 'A', joined_at: 1 },
    { wallMs: 0, monoMs: 0 }
  )
  s.peerLeft('peer-a', { wallMs: 30 * MINUTE, monoMs: 30 * MINUTE })

  const finalized = s.finalizePeerPresence({
    wallMs: 120 * MINUTE,
    monoMs: 120 * MINUTE,
  })
  expect(finalized.durationsMs).toEqual({ [ED_A]: 30 * MINUTE })
  expect(finalized.lastStudiedAt).toEqual({ [ED_A]: 30 * MINUTE })
})

test('leave and rejoin sums presence intervals but excludes the gap', () => {
  const s = useSessionStore.getState()
  s.peerJoined('peer-a')
  s.setPeerHello(
    'peer-a',
    { ed_pubkey_hex: ED_A, display_name: 'A', joined_at: 1 },
    { wallMs: 0, monoMs: 0 }
  )
  s.peerLeft('peer-a', { wallMs: 20 * MINUTE, monoMs: 20 * MINUTE })
  s.peerJoined('peer-a')
  s.setPeerHello(
    'peer-a',
    { ed_pubkey_hex: ED_A, display_name: 'A', joined_at: 2 },
    { wallMs: 30 * MINUTE, monoMs: 30 * MINUTE }
  )

  const finalized = s.finalizePeerPresence({
    wallMs: 60 * MINUTE,
    monoMs: 60 * MINUTE,
  })
  expect(finalized.durationsMs[ED_A]).toBe(50 * MINUTE)
  expect(finalized.lastStudiedAt[ED_A]).toBe(60 * MINUTE)
})

test('multiple peers accumulate independent overlap intervals', () => {
  const s = useSessionStore.getState()
  s.peerJoined('peer-a')
  s.setPeerHello(
    'peer-a',
    { ed_pubkey_hex: ED_A, display_name: 'A', joined_at: 1 },
    { wallMs: 0, monoMs: 0 }
  )
  s.peerJoined('peer-b')
  s.setPeerHello(
    'peer-b',
    { ed_pubkey_hex: ED_B, display_name: 'B', joined_at: 2 },
    { wallMs: 10 * MINUTE, monoMs: 10 * MINUTE }
  )
  s.peerLeft('peer-a', { wallMs: 30 * MINUTE, monoMs: 30 * MINUTE })
  s.peerLeft('peer-b', { wallMs: 50 * MINUTE, monoMs: 50 * MINUTE })

  expect(s.finalizePeerPresence().durationsMs).toEqual({
    [ED_A]: 30 * MINUTE,
    [ED_B]: 40 * MINUTE,
  })
})

test('repeated hello does not restart an active interval', () => {
  const s = useSessionStore.getState()
  s.peerJoined('peer-a')
  s.setPeerHello(
    'peer-a',
    { ed_pubkey_hex: ED_A, display_name: 'A', joined_at: 1 },
    { wallMs: 0, monoMs: 0 }
  )
  s.setPeerHello(
    'peer-a',
    { ed_pubkey_hex: ED_A, display_name: 'Renamed A', joined_at: 2 },
    { wallMs: 10 * MINUTE, monoMs: 10 * MINUTE }
  )
  s.peerLeft('peer-a', { wallMs: 20 * MINUTE, monoMs: 20 * MINUTE })

  expect(s.finalizePeerPresence().durationsMs[ED_A]).toBe(20 * MINUTE)
})

test('duplicate connections for one identity do not double-count', () => {
  const s = useSessionStore.getState()
  s.peerJoined('peer-a1')
  s.setPeerHello(
    'peer-a1',
    { ed_pubkey_hex: ED_A, display_name: 'A', joined_at: 1 },
    { wallMs: 0, monoMs: 0 }
  )
  s.peerJoined('peer-a2')
  s.setPeerHello(
    'peer-a2',
    { ed_pubkey_hex: ED_A, display_name: 'A', joined_at: 2 },
    { wallMs: 10 * MINUTE, monoMs: 10 * MINUTE }
  )

  expect(
    s.peerLeft('peer-a1', { wallMs: 20 * MINUTE, monoMs: 20 * MINUTE })
  ).toBeNull()
  expect(
    s.peerLeft('peer-a2', { wallMs: 30 * MINUTE, monoMs: 30 * MINUTE })
  ).toEqual({ edPubkeyHex: ED_A, endedAt: 30 * MINUTE })
  expect(s.finalizePeerPresence().durationsMs[ED_A]).toBe(30 * MINUTE)
})

test('transport peers without an authenticated hello never enter presence data', () => {
  const s = useSessionStore.getState()
  s.peerJoined('unauthenticated')
  s.peerLeft('unauthenticated', { wallMs: MINUTE, monoMs: MINUTE })
  expect(s.finalizePeerPresence().durationsMs).toEqual({})
  expect(s.collectPeerPubkeys()).toBeNull()
})

test('finalization is idempotent and does not extend a closed interval', () => {
  const s = useSessionStore.getState()
  s.peerJoined('peer-a')
  s.setPeerHello(
    'peer-a',
    { ed_pubkey_hex: ED_A, display_name: 'A', joined_at: 1 },
    { wallMs: 0, monoMs: 0 }
  )

  expect(
    s.finalizePeerPresence({ wallMs: 10 * MINUTE, monoMs: 10 * MINUTE })
      .durationsMs[ED_A]
  ).toBe(10 * MINUTE)
  expect(
    s.finalizePeerPresence({ wallMs: 30 * MINUTE, monoMs: 30 * MINUTE })
      .durationsMs[ED_A]
  ).toBe(10 * MINUTE)
})

test('presence uses the shorter wall and monotonic elapsed time', () => {
  const s = useSessionStore.getState()
  s.peerJoined('peer-a')
  s.setPeerHello(
    'peer-a',
    { ed_pubkey_hex: ED_A, display_name: 'A', joined_at: 1 },
    { wallMs: 0, monoMs: 0 }
  )
  s.peerLeft('peer-a', {
    wallMs: 120 * MINUTE,
    monoMs: 30 * MINUTE,
  })
  expect(s.finalizePeerPresence().durationsMs[ED_A]).toBe(30 * MINUTE)
})

test('a backward wall clock cannot create negative presence', () => {
  const s = useSessionStore.getState()
  s.peerJoined('peer-a')
  s.setPeerHello(
    'peer-a',
    { ed_pubkey_hex: ED_A, display_name: 'A', joined_at: 1 },
    { wallMs: 10 * MINUTE, monoMs: 0 }
  )
  s.peerLeft('peer-a', { wallMs: 5 * MINUTE, monoMs: 5 * MINUTE })
  expect(s.finalizePeerPresence().durationsMs[ED_A]).toBe(0)
})

test('a bound transport cannot rebind to another identity', () => {
  const s = useSessionStore.getState()
  s.peerJoined('peer-a')
  s.setPeerHello(
    'peer-a',
    { ed_pubkey_hex: ED_A, display_name: 'A', joined_at: 1 },
    { wallMs: 0, monoMs: 0 }
  )
  s.setPeerHello(
    'peer-a',
    { ed_pubkey_hex: ED_B, display_name: 'B', joined_at: 2 },
    { wallMs: MINUTE, monoMs: MINUTE }
  )

  expect(useSessionStore.getState().peers['peer-a']?.edPubkeyHex).toBe(ED_A)
  expect(useSessionStore.getState().seenPeerEdPubkeys).toEqual([ED_A])
})
