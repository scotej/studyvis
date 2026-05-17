// Regression (I1/I3): the everyone-else-leaves auto-end path used to lose
// sessions.peer_pubkeys + markStudied because `peerLeft` pruned `peers`
// before the leave handler snapshotted. `seenPeerEdPubkeys` is cumulative
// and must survive `peerLeft`.

import { afterEach, expect, test } from 'vitest'

import { useSessionStore } from '@/stores/sessionStore'

afterEach(() => {
  useSessionStore.getState().reset()
})

const ED_A = 'aa'.repeat(32)
const ED_B = 'bb'.repeat(32)

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

  // Both peers leave (the auto-end path empties the peers map entirely).
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
