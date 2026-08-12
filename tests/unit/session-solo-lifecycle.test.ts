// #210 — remote membership changes never terminate the local study session.
// `wireSessionRoom` owns only membership and admission; local Leave and
// explicit forced rejection are the only paths that may invoke teardown.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import {
  MAX_REMOTE_PEERS,
  ADMISSION_AUTHENTICATION_TIMEOUT_MS,
  ADMISSION_AUTHORITY_ACTION,
  REJOIN_WINDOW_MS,
  SESSION_FULL_ACTION,
  wireSessionRoom,
} from '@/features/session/lifecycle'
import type { TopicRoom } from '@/lib/trystero'
import { useSessionStore } from '@/stores/sessionStore'

type Listener = (peerId: string) => void
type Receiver = (data: unknown, peerId: string) => void

function fakeRoom() {
  const joinSubs = new Set<Listener>()
  const leaveSubs = new Set<Listener>()
  const actionReceivers = new Map<string, Receiver>()
  const actionSend = vi.fn(async (data: unknown, peerId?: string) => {
    void data
    void peerId
    return []
  })
  const peerCloses = new Map<string, ReturnType<typeof vi.fn>>()
  const room = {
    selfId: 'self',
    makeAction: (namespace: string) => ({
      send: actionSend,
      receive: (fn: Receiver) => actionReceivers.set(namespace, fn),
    }),
    onPeerJoin: (fn: Listener) => {
      joinSubs.add(fn)
      return () => joinSubs.delete(fn)
    },
    onPeerLeave: (fn: Listener) => {
      leaveSubs.add(fn)
      return () => leaveSubs.delete(fn)
    },
    onPeerStream: () => () => {},
    addStream: () => {},
    removeStream: () => {},
    getPeers: () =>
      Object.fromEntries(
        Array.from(peerCloses, ([peerId, close]) => [peerId, { close }])
      ),
    leave: async () => {},
  } as unknown as TopicRoom
  return {
    room,
    actionSend,
    join(peerId: string) {
      if (!peerCloses.has(peerId)) {
        peerCloses.set(peerId, vi.fn())
      }
      for (const fn of joinSubs) fn(peerId)
    },
    leave(peerId: string) {
      for (const fn of leaveSubs) fn(peerId)
    },
    receiveSessionFull(peerId = 'host') {
      actionReceivers.get(SESSION_FULL_ACTION)?.(null, peerId)
    },
    receiveAdmissionAuthority(
      peerId: string,
      authorityPeerId: string,
      admittedPeerIds: string[] = ['self'],
      rosterRevision = 0
    ) {
      actionReceivers.get(ADMISSION_AUTHORITY_ACTION)?.(
        {
          v: 1,
          authority_peer_id: authorityPeerId,
          admitted_peer_ids: admittedPeerIds,
          roster_revision: rosterRevision,
        },
        peerId
      )
    },
    peerCloseCount(peerId: string) {
      return peerCloses.get(peerId)?.mock.calls.length ?? 0
    },
  }
}

function beginActive(room: TopicRoom, leave: () => Promise<void>): void {
  useSessionStore.getState().begin({
    sessionTopic: 'topic',
    sessionPassword: 'password',
    isHost: true,
    startedAt: 1_700_000_000_000,
    startedAtMono: 10,
    room,
    leave,
  })
}

describe('#210 active solo session lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    useSessionStore.getState().reset()
  })

  afterEach(() => {
    useSessionStore.getState().reset()
    vi.useRealTimers()
  })

  test('the last peer leaving keeps the same local session active indefinitely', async () => {
    const harness = fakeRoom()
    const localLeave = vi.fn(async () => {})
    beginActive(harness.room, localLeave)
    const lifecycle = wireSessionRoom(harness.room, {
      isHost: true,
      leave: localLeave,
    })

    harness.join('peer-a')
    harness.leave('peer-a')

    const state = useSessionStore.getState()
    expect(lifecycle.peers()).toEqual([])
    expect(state.status).toBe('active')
    expect(state.room).toBe(harness.room)
    expect(state.leave).toBe(localLeave)
    expect(state.hadAnyPeer).toBe(true)
    expect(vi.getTimerCount()).toBe(0)

    await vi.advanceTimersByTimeAsync(20 * 60_000)
    expect(localLeave).not.toHaveBeenCalled()
    expect(useSessionStore.getState().status).toBe('active')
  })

  test('authenticated peer departure closes overlap but not the local session', () => {
    const harness = fakeRoom()
    const localLeave = vi.fn(async () => {})
    beginActive(harness.room, localLeave)
    wireSessionRoom(harness.room, { isHost: true, leave: localLeave })

    harness.join('peer-a')
    useSessionStore.getState().setPeerHello(
      'peer-a',
      {
        ed_pubkey_hex: 'a'.repeat(64),
        display_name: 'Ada',
        joined_at: 1,
      },
      { wallMs: 1_000, monoMs: 100 }
    )
    harness.leave('peer-a')

    const state = useSessionStore.getState()
    expect(state.status).toBe('active')
    expect(state.peers).toEqual({})
    expect(state.peerPresence['a'.repeat(64)]?.activeSinceMono).toBeNull()
    expect(localLeave).not.toHaveBeenCalled()
  })

  test('a three-person session dropping to one stays active', () => {
    const harness = fakeRoom()
    const localLeave = vi.fn(async () => {})
    beginActive(harness.room, localLeave)
    const lifecycle = wireSessionRoom(harness.room, {
      isHost: true,
      leave: localLeave,
    })

    harness.join('peer-a')
    harness.join('peer-b')
    harness.leave('peer-a')
    harness.leave('peer-b')

    expect(lifecycle.peers()).toEqual([])
    expect(useSessionStore.getState().status).toBe('active')
    expect(localLeave).not.toHaveBeenCalled()
  })

  test('departed peers can reconnect and new peers can join the live room', () => {
    const harness = fakeRoom()
    const localLeave = vi.fn(async () => {})
    beginActive(harness.room, localLeave)
    const lifecycle = wireSessionRoom(harness.room, {
      isHost: true,
      leave: localLeave,
    })

    harness.join('peer-a')
    harness.leave('peer-a')
    harness.join('peer-a')
    expect(lifecycle.peers()).toEqual(['peer-a'])
    harness.leave('peer-a')
    harness.join('peer-new')

    expect(lifecycle.peers()).toEqual(['peer-new'])
    expect(useSessionStore.getState().status).toBe('active')
    expect(localLeave).not.toHaveBeenCalled()
  })

  test('the original host announces its stable peer ID to each admitted guest', () => {
    const harness = fakeRoom()
    const localLeave = vi.fn(async () => {})
    beginActive(harness.room, localLeave)
    wireSessionRoom(
      harness.room,
      {
        isHost: true,
        leave: localLeave,
      },
      useSessionStore
    )

    harness.join('guest-peer')
    expect(harness.actionSend).toHaveBeenCalledWith(
      {
        v: 1,
        authority_peer_id: 'self',
        admitted_peer_ids: ['guest-peer'],
        roster_revision: 0,
      },
      'guest-peer'
    )
  })

  test('a later entrant cannot replace the announced original-host authority', () => {
    const harness = fakeRoom()
    const localLeave = vi.fn(async () => {})
    beginActive(harness.room, localLeave)
    const lifecycle = wireSessionRoom(harness.room, {
      isHost: false,
      leave: localLeave,
    })

    harness.join('authority-peer')
    harness.receiveAdmissionAuthority('authority-peer', 'authority-peer')
    harness.join('later-peer')
    harness.receiveAdmissionAuthority('later-peer', 'later-peer')
    harness.leave('authority-peer')
    harness.join('delayed-invitee')

    expect(lifecycle.peers()).toEqual([])
    expect(harness.peerCloseCount('later-peer')).toBe(1)
    expect(harness.peerCloseCount('delayed-invitee')).toBe(1)
  })

  test('a signed-inviter binding prevents a racing peer from claiming authority', () => {
    const harness = fakeRoom()
    const localLeave = vi.fn(async () => {})
    const expectedHostEdPubkey = 'a'.repeat(64)
    beginActive(harness.room, localLeave)
    const lifecycle = wireSessionRoom(harness.room, {
      isHost: false,
      expectedAuthorityEdPubkeyHex: expectedHostEdPubkey,
      leave: localLeave,
    })

    harness.join('real-host')
    harness.join('racing-peer')
    // A later self-asserted roster must remain isolated in its own pending
    // slot, not overwrite the genuine host claim before its signed hello.
    harness.receiveAdmissionAuthority('real-host', 'real-host')
    harness.receiveAdmissionAuthority('racing-peer', 'racing-peer')
    lifecycle.authenticateAuthority('racing-peer', 'b'.repeat(64))
    harness.receiveSessionFull('racing-peer')
    expect(localLeave).not.toHaveBeenCalled()

    lifecycle.authenticateAuthority('real-host', expectedHostEdPubkey)
    expect(lifecycle.peers()).toEqual(['real-host'])

    harness.receiveSessionFull('real-host')
    expect(localLeave).toHaveBeenCalledTimes(1)
  })

  test('an authority-authenticated roster excluding this guest ends the rejected attempt', async () => {
    const harness = fakeRoom()
    const localLeave = vi.fn(async () => {})
    const expectedHostEdPubkey = 'a'.repeat(64)
    beginActive(harness.room, localLeave)
    const lifecycle = wireSessionRoom(harness.room, {
      isHost: false,
      expectedAuthorityEdPubkeyHex: expectedHostEdPubkey,
      leave: localLeave,
    })

    harness.join('real-host')
    harness.receiveAdmissionAuthority('real-host', 'real-host', [])
    lifecycle.authenticateAuthority('real-host', expectedHostEdPubkey)
    await Promise.resolve()

    expect(lifecycle.peers()).toEqual([])
    expect(localLeave).toHaveBeenCalledTimes(1)
    expect(useSessionStore.getState().pendingEndReason).toBe('peer')
  })

  test('a signed-inviter hello interoperates with a legacy host without a roster', async () => {
    const harness = fakeRoom()
    const localLeave = vi.fn(async () => {})
    const expectedHostEdPubkey = 'a'.repeat(64)
    beginActive(harness.room, localLeave)
    const lifecycle = wireSessionRoom(harness.room, {
      isHost: false,
      expectedAuthorityEdPubkeyHex: expectedHostEdPubkey,
      leave: localLeave,
    })

    harness.join('legacy-host')
    lifecycle.authenticateAuthority('legacy-host', expectedHostEdPubkey)
    await vi.advanceTimersByTimeAsync(350)

    expect(lifecycle.peers()).toEqual(['legacy-host'])
    harness.receiveSessionFull('legacy-host')
    expect(localLeave).toHaveBeenCalledTimes(1)
  })

  test('a legacy host hello admits the already-connected pre-hello mesh', async () => {
    const harness = fakeRoom()
    const localLeave = vi.fn(async () => {})
    const expectedHostEdPubkey = 'a'.repeat(64)
    beginActive(harness.room, localLeave)
    const lifecycle = wireSessionRoom(harness.room, {
      isHost: false,
      expectedAuthorityEdPubkeyHex: expectedHostEdPubkey,
      leave: localLeave,
    })

    harness.join('legacy-host')
    harness.join('incumbent-a')
    harness.join('incumbent-b')
    lifecycle.authenticateAuthority('legacy-host', expectedHostEdPubkey)
    await vi.advanceTimersByTimeAsync(350)

    expect(lifecycle.peers()).toEqual([
      'legacy-host',
      'incumbent-a',
      'incumbent-b',
    ])
    expect(localLeave).not.toHaveBeenCalled()
  })

  test('a legacy full-room fallback rejects the joining fifth without evicting incumbents', async () => {
    const harness = fakeRoom()
    const localLeave = vi.fn(async () => {})
    const expectedHostEdPubkey = 'a'.repeat(64)
    beginActive(harness.room, localLeave)
    const lifecycle = wireSessionRoom(harness.room, {
      isHost: false,
      expectedAuthorityEdPubkeyHex: expectedHostEdPubkey,
      leave: localLeave,
    })

    harness.join('legacy-host')
    harness.join('incumbent-a')
    harness.join('incumbent-b')
    harness.join('incumbent-c')
    lifecycle.authenticateAuthority('legacy-host', expectedHostEdPubkey)
    await vi.advanceTimersByTimeAsync(350)

    expect(localLeave).toHaveBeenCalledTimes(1)
    expect(lifecycle.peers()).toEqual([])
    expect(harness.peerCloseCount('incumbent-a')).toBe(0)
    expect(harness.peerCloseCount('incumbent-b')).toBe(0)
  })

  test('a legacy fallback preserves its bounded incumbents and closes a later entrant', async () => {
    const harness = fakeRoom()
    const localLeave = vi.fn(async () => {})
    const expectedHostEdPubkey = 'a'.repeat(64)
    beginActive(harness.room, localLeave)
    const lifecycle = wireSessionRoom(harness.room, {
      isHost: false,
      expectedAuthorityEdPubkeyHex: expectedHostEdPubkey,
      leave: localLeave,
    })

    harness.join('legacy-host')
    harness.join('incumbent-a')
    harness.join('incumbent-b')
    lifecycle.authenticateAuthority('legacy-host', expectedHostEdPubkey)
    await vi.advanceTimersByTimeAsync(350)
    harness.join('late-peer')

    expect(lifecycle.peers()).toEqual([
      'legacy-host',
      'incumbent-a',
      'incumbent-b',
    ])
    expect(harness.peerCloseCount('late-peer')).toBe(1)
    expect(localLeave).not.toHaveBeenCalled()
  })

  test('host loss during the bounded legacy grace rejects an unadmitted guest', async () => {
    const harness = fakeRoom()
    const localLeave = vi.fn(async () => {})
    const expectedHostEdPubkey = 'a'.repeat(64)
    beginActive(harness.room, localLeave)
    const lifecycle = wireSessionRoom(harness.room, {
      isHost: false,
      expectedAuthorityEdPubkeyHex: expectedHostEdPubkey,
      leave: localLeave,
    })

    harness.join('legacy-host')
    harness.join('incumbent')
    lifecycle.authenticateAuthority('legacy-host', expectedHostEdPubkey)
    harness.leave('legacy-host')
    await vi.advanceTimersByTimeAsync(350)

    expect(lifecycle.peers()).toEqual([])
    expect(localLeave).toHaveBeenCalledTimes(1)
  })

  test('legacy full-room host loss during grace rejects the prospective fifth', () => {
    const harness = fakeRoom()
    const localLeave = vi.fn(async () => {})
    const expectedHostEdPubkey = 'a'.repeat(64)
    beginActive(harness.room, localLeave)
    const lifecycle = wireSessionRoom(harness.room, {
      isHost: false,
      expectedAuthorityEdPubkeyHex: expectedHostEdPubkey,
      leave: localLeave,
    })

    harness.join('legacy-host')
    harness.join('incumbent-a')
    harness.join('incumbent-b')
    harness.join('incumbent-c')
    lifecycle.authenticateAuthority('legacy-host', expectedHostEdPubkey)
    harness.leave('legacy-host')

    expect(localLeave).toHaveBeenCalledTimes(1)
    expect(lifecycle.peers()).toEqual([])
  })

  test('an authenticated legacy host reopens admission after its same-ID rejoin', async () => {
    const harness = fakeRoom()
    const localLeave = vi.fn(async () => {})
    const expectedHostEdPubkey = 'a'.repeat(64)
    beginActive(harness.room, localLeave)
    const lifecycle = wireSessionRoom(harness.room, {
      isHost: false,
      expectedAuthorityEdPubkeyHex: expectedHostEdPubkey,
      leave: localLeave,
    })

    harness.join('legacy-host')
    lifecycle.authenticateAuthority('legacy-host', expectedHostEdPubkey)
    await vi.advanceTimersByTimeAsync(350)
    harness.leave('legacy-host')

    harness.join('legacy-host')
    lifecycle.authenticateAuthority('legacy-host', expectedHostEdPubkey)
    await vi.advanceTimersByTimeAsync(350)
    harness.join('post-rejoin-peer')

    expect(lifecycle.peers()).toEqual(['legacy-host', 'post-rejoin-peer'])
    expect(harness.peerCloseCount('post-rejoin-peer')).toBe(0)
  })

  test('a guest rejoin restores the frozen authenticated host-loss roster', () => {
    const expectedHostEdPubkey = 'a'.repeat(64)
    const first = fakeRoom()
    const localLeave = vi.fn(async () => {})
    beginActive(first.room, localLeave)
    const beforeLeave = wireSessionRoom(first.room, {
      isHost: false,
      expectedAuthorityEdPubkeyHex: expectedHostEdPubkey,
      leave: localLeave,
    })

    first.join('host')
    first.receiveAdmissionAuthority('host', 'host', ['self', 'incumbent'])
    beforeLeave.authenticateAuthority('host', expectedHostEdPubkey)
    first.join('incumbent')
    first.leave('host')
    const frozen = beforeLeave.getFrozenGuestAdmission()
    expect(frozen).toEqual({
      authorityPeerId: 'host',
      authorityEdPubkeyHex: expectedHostEdPubkey,
      admittedPeerIds: ['self', 'incumbent'],
    })
    beforeLeave.dispose()

    const rejoined = fakeRoom()
    beginActive(rejoined.room, localLeave)
    const afterRejoin = wireSessionRoom(rejoined.room, {
      isHost: false,
      expectedAuthorityEdPubkeyHex: expectedHostEdPubkey,
      frozenGuestAdmission: frozen,
      leave: localLeave,
    })
    rejoined.join('incumbent')

    expect(afterRejoin.peers()).toEqual(['incumbent'])
    expect(rejoined.peerCloseCount('incumbent')).toBe(0)
  })

  test.each(['join-then-hello', 'hello-then-join'])(
    'a frozen guest lets only the signed host reopen admission (%s)',
    (ordering) => {
      const harness = fakeRoom()
      const localLeave = vi.fn(async () => {})
      const expectedHostEdPubkey = 'a'.repeat(64)
      beginActive(harness.room, localLeave)
      const lifecycle = wireSessionRoom(harness.room, {
        isHost: false,
        expectedAuthorityEdPubkeyHex: expectedHostEdPubkey,
        frozenGuestAdmission: {
          authorityPeerId: 'host',
          authorityEdPubkeyHex: expectedHostEdPubkey,
          admittedPeerIds: ['self', 'incumbent'],
        },
        leave: localLeave,
      })

      if (ordering === 'join-then-hello') {
        harness.join('host')
        lifecycle.authenticateAuthority('host', expectedHostEdPubkey)
      } else {
        lifecycle.authenticateAuthority('host', expectedHostEdPubkey)
        harness.join('host')
      }
      harness.join('unlisted-new-peer')

      expect(lifecycle.peers()).toEqual(['host'])
      // Reopening lets the live host authorize again, but the frozen roster
      // never admits an unseen transport by itself.
      expect(harness.peerCloseCount('unlisted-new-peer')).toBe(0)
      expect(localLeave).not.toHaveBeenCalled()
    }
  )

  test('a roster-capable host keeps an unseen candidate provisional through host loss', async () => {
    const harness = fakeRoom()
    const localLeave = vi.fn(async () => {})
    beginActive(harness.room, localLeave)
    const lifecycle = wireSessionRoom(harness.room, {
      isHost: false,
      leave: localLeave,
    })

    harness.join('host')
    harness.receiveAdmissionAuthority('host', 'host', ['self', 'incumbent'])
    harness.join('incumbent')
    harness.join('rejected-fifth')
    // Simulate the host disappearing before an outbound rejection roster can
    // be observed. The candidate was never admitted, so it must not become an
    // incumbent merely because its transport leave races the authority leave.
    harness.leave('host')

    expect(lifecycle.peers()).toEqual(['incumbent'])
    await vi.advanceTimersByTimeAsync(ADMISSION_AUTHENTICATION_TIMEOUT_MS)
    expect(harness.peerCloseCount('rejected-fifth')).toBe(1)
    expect(localLeave).not.toHaveBeenCalled()
    expect(lifecycle.peers()).toEqual(['incumbent'])
  })

  test('disposing a local room clears pending admission and reservation timers', async () => {
    const guestHarness = fakeRoom()
    const guestLeave = vi.fn(async () => {})
    beginActive(guestHarness.room, guestLeave)
    const guestLifecycle = wireSessionRoom(guestHarness.room, {
      isHost: false,
      leave: guestLeave,
    })
    guestHarness.join('unknown-peer')

    const hostHarness = fakeRoom()
    const hostLeave = vi.fn(async () => {})
    beginActive(hostHarness.room, hostLeave)
    const hostLifecycle = wireSessionRoom(hostHarness.room, {
      isHost: true,
      reservedReconnectPeerIds: ['reserved-peer'],
      leave: hostLeave,
    })

    guestLifecycle.dispose()
    hostLifecycle.dispose()
    await vi.advanceTimersByTimeAsync(REJOIN_WINDOW_MS + 1)

    expect(guestLeave).not.toHaveBeenCalled()
    expect(guestHarness.peerCloseCount('unknown-peer')).toBe(0)
    expect(hostHarness.actionSend).not.toHaveBeenCalled()
    expect(hostLeave).not.toHaveBeenCalled()
  })

  test('an unannounced guest never admits another unverified guest into a mesh', async () => {
    const harness = fakeRoom()
    const localLeave = vi.fn(async () => {})
    beginActive(harness.room, localLeave)
    const lifecycle = wireSessionRoom(harness.room, {
      isHost: false,
      leave: localLeave,
    })

    harness.join('unverified-peer')
    expect(lifecycle.peers()).toEqual([])

    await vi.advanceTimersByTimeAsync(3_000)
    expect(lifecycle.peers()).toEqual([])
    expect(harness.peerCloseCount('unverified-peer')).toBe(1)
    expect(localLeave).toHaveBeenCalledTimes(1)
  })

  test('transient entrants rejected before host loss cannot later reconnect', () => {
    const harness = fakeRoom()
    const localLeave = vi.fn(async () => {})
    beginActive(harness.room, localLeave)
    const lifecycle = wireSessionRoom(harness.room, {
      isHost: false,
      leave: localLeave,
    })

    harness.join('authority-peer')
    harness.receiveAdmissionAuthority('authority-peer', 'authority-peer')
    // These peers were briefly visible to the guest before the original host
    // rejected them. A guest must not retain them in its reconnect allowlist.
    harness.join('transient-a')
    harness.join('transient-b')
    harness.leave('transient-a')
    harness.leave('transient-b')
    harness.leave('authority-peer')

    harness.join('transient-a')
    harness.join('transient-b')
    expect(lifecycle.peers()).toEqual([])
    expect(harness.peerCloseCount('transient-a')).toBe(1)
    expect(harness.peerCloseCount('transient-b')).toBe(1)
  })

  test('a frozen authority roster closes a rejected peer when host leave races its transport leave', () => {
    const harness = fakeRoom()
    const localLeave = vi.fn(async () => {})
    beginActive(harness.room, localLeave)
    const lifecycle = wireSessionRoom(harness.room, {
      isHost: false,
      leave: localLeave,
    })

    harness.join('authority-peer')
    harness.receiveAdmissionAuthority('authority-peer', 'authority-peer', [
      'self',
      'incumbent-peer',
    ])
    harness.join('incumbent-peer')
    // The host rejected this delayed peer, but the guest has not yet received
    // its onPeerLeave callback when the host connection disappears.
    harness.join('rejected-peer')
    harness.leave('authority-peer')

    expect(lifecycle.peers()).toEqual(['incumbent-peer'])
    expect(harness.peerCloseCount('incumbent-peer')).toBe(0)
    expect(harness.peerCloseCount('rejected-peer')).toBeGreaterThanOrEqual(1)

    harness.leave('rejected-peer')
    expect(lifecycle.peers()).toEqual(['incumbent-peer'])
    expect(useSessionStore.getState().status).toBe('active')
  })

  test('authority loss permits known reconnects, then only its return reopens admission', () => {
    const harness = fakeRoom()
    const localLeave = vi.fn(async () => {})
    beginActive(harness.room, localLeave)
    const lifecycle = wireSessionRoom(harness.room, {
      isHost: false,
      leave: localLeave,
    })

    harness.join('authority-peer')
    harness.receiveAdmissionAuthority('authority-peer', 'authority-peer', [
      'self',
      'known-peer',
    ])
    harness.join('known-peer')
    harness.leave('authority-peer')
    harness.leave('known-peer')

    // A participant that was admitted before authority loss can recover its
    // transport connection, but unseen durable invites remain fail-closed.
    harness.join('known-peer')
    expect(lifecycle.peers()).toEqual(['known-peer'])
    expect(localLeave).not.toHaveBeenCalled()

    harness.join('delayed-invitee')
    expect(lifecycle.peers()).toEqual(['known-peer'])
    expect(harness.peerCloseCount('delayed-invitee')).toBe(1)

    // An unseen delayed peer cannot turn an early action into an authority
    // claim after admission has closed.
    harness.receiveAdmissionAuthority('delayed-claimant', 'delayed-claimant')
    harness.join('delayed-claimant')
    expect(lifecycle.peers()).toEqual(['known-peer'])
    expect(harness.peerCloseCount('delayed-claimant')).toBe(1)

    // The original host has the announced stable ID, so its recovery is the
    // only reconnect that resumes admission for future invitees.
    harness.join('authority-peer')
    harness.receiveAdmissionAuthority('authority-peer', 'authority-peer', [
      'self',
      'known-peer',
      'invite-after-authority-reconnect',
    ])
    harness.join('invite-after-authority-reconnect')
    expect(lifecycle.peers()).toEqual([
      'known-peer',
      'authority-peer',
      'invite-after-authority-reconnect',
    ])
  })

  test('a rejoining host reserves incumbent slots before accepting delayed peers', async () => {
    const harness = fakeRoom()
    const localLeave = vi.fn(async () => {})
    beginActive(harness.room, localLeave)
    const lifecycle = wireSessionRoom(harness.room, {
      isHost: true,
      reservedReconnectPeerIds: ['incumbent-a', 'incumbent-b', 'incumbent-c'],
      leave: localLeave,
    })

    harness.join('delayed-invitee')
    harness.join('incumbent-a')
    harness.join('incumbent-b')
    harness.join('incumbent-c')
    await Promise.resolve()

    expect(lifecycle.peers()).toEqual([
      'incumbent-a',
      'incumbent-b',
      'incumbent-c',
    ])
    expect(harness.actionSend).toHaveBeenCalledWith(
      expect.objectContaining({
        admitted_peer_ids: ['incumbent-a', 'incumbent-b', 'incumbent-c'],
      }),
      'delayed-invitee'
    )
  })

  test('a departed peer frees host capacity for another participant', async () => {
    const harness = fakeRoom()
    const localLeave = vi.fn(async () => {})
    beginActive(harness.room, localLeave)
    const lifecycle = wireSessionRoom(harness.room, {
      isHost: true,
      leave: localLeave,
    })

    for (let i = 1; i <= MAX_REMOTE_PEERS; i += 1) {
      harness.join(`peer-${i}`)
    }
    harness.join('rejected')
    await Promise.resolve()
    expect(lifecycle.peers()).toHaveLength(MAX_REMOTE_PEERS)
    expect(harness.actionSend).toHaveBeenCalledWith(
      expect.objectContaining({
        admitted_peer_ids: ['peer-1', 'peer-2', 'peer-3'],
      }),
      'rejected'
    )

    harness.leave('peer-1')
    harness.join('replacement')
    expect(lifecycle.peers()).toEqual([
      ...Array.from(
        { length: MAX_REMOTE_PEERS - 1 },
        (_, index) => `peer-${index + 2}`
      ),
      'replacement',
    ])
    expect(localLeave).not.toHaveBeenCalled()
  })

  test('host roster updates remove departed peers and reservation expiry', async () => {
    const harness = fakeRoom()
    const localLeave = vi.fn(async () => {})
    beginActive(harness.room, localLeave)
    wireSessionRoom(harness.room, {
      isHost: true,
      reservedReconnectPeerIds: ['reserved-peer'],
      leave: localLeave,
    })

    await vi.advanceTimersByTimeAsync(REJOIN_WINDOW_MS)
    expect(harness.actionSend).not.toHaveBeenCalled()

    harness.join('peer-a')
    harness.join('peer-b')
    harness.join('peer-c')
    harness.leave('peer-a')
    harness.join('replacement')

    const rosterPayloads = harness.actionSend.mock.calls
      .map(([payload]) => payload)
      .filter(
        (payload): payload is { admitted_peer_ids: string[] } =>
          typeof payload === 'object' &&
          payload !== null &&
          'admitted_peer_ids' in payload &&
          Array.isArray(payload.admitted_peer_ids)
      )
    expect(
      rosterPayloads.every(
        ({ admitted_peer_ids }) => admitted_peer_ids.length <= MAX_REMOTE_PEERS
      )
    ).toBe(true)
    expect(rosterPayloads.at(-1)?.admitted_peer_ids).toEqual([
      'peer-b',
      'peer-c',
      'replacement',
    ])
  })

  test('a host handles failed rejection notices and still closes the excess transport', async () => {
    const harness = fakeRoom()
    const localLeave = vi.fn(async () => {})
    beginActive(harness.room, localLeave)
    wireSessionRoom(harness.room, { isHost: true, leave: localLeave })

    for (let i = 1; i <= MAX_REMOTE_PEERS; i += 1) {
      harness.join(`peer-${i}`)
    }
    harness.actionSend.mockRejectedValueOnce(new Error('action unavailable'))
    harness.join('excess-peer')
    await vi.advanceTimersByTimeAsync(99)

    expect(harness.peerCloseCount('excess-peer')).toBe(1)
    expect(localLeave).not.toHaveBeenCalled()
  })

  test('unknown and duplicate leave callbacks are inert', () => {
    const harness = fakeRoom()
    const localLeave = vi.fn(async () => {})
    beginActive(harness.room, localLeave)
    const lifecycle = wireSessionRoom(harness.room, {
      isHost: true,
      leave: localLeave,
    })

    harness.leave('ghost')
    harness.join('peer-a')
    harness.leave('peer-a')
    harness.leave('peer-a')

    expect(lifecycle.peers()).toEqual([])
    expect(localLeave).not.toHaveBeenCalled()
  })

  test('session-full still forces the rejected guest to end without Rejoin', () => {
    const harness = fakeRoom()
    const localLeave = vi.fn(async () => {})
    useSessionStore.getState().begin({
      sessionTopic: 'topic',
      sessionPassword: 'password',
      isHost: false,
      startedAt: 1_700_000_000_000,
      room: harness.room,
      leave: localLeave,
    })
    wireSessionRoom(harness.room, { isHost: false, leave: localLeave })
    harness.join('host')
    harness.receiveAdmissionAuthority('host', 'host')

    harness.receiveSessionFull()

    expect(localLeave).toHaveBeenCalledTimes(1)
    expect(useSessionStore.getState().pendingEndReason).toBe('peer')
    expect(useSessionStore.getState().rejoinDeadline).toBeNull()
  })

  test('session-full handles a failing Leave without an unhandled action rejection', async () => {
    const harness = fakeRoom()
    const localLeave = vi.fn(async () => {
      throw new Error('leave notification failed')
    })
    beginActive(harness.room, localLeave)
    wireSessionRoom(harness.room, { isHost: false, leave: localLeave })
    harness.join('host')
    harness.receiveAdmissionAuthority('host', 'host')

    harness.receiveSessionFull()
    await Promise.resolve()

    expect(localLeave).toHaveBeenCalledTimes(1)
    expect(useSessionStore.getState().pendingEndReason).toBe('peer')
  })

  test('a guest cannot forge session-full against an announced incumbent', () => {
    const harness = fakeRoom()
    const localLeave = vi.fn(async () => {})
    beginActive(harness.room, localLeave)
    wireSessionRoom(harness.room, { isHost: false, leave: localLeave })
    harness.join('authority-peer')
    harness.receiveAdmissionAuthority('authority-peer', 'authority-peer')
    harness.join('forging-guest')

    harness.receiveSessionFull('forging-guest')

    expect(localLeave).not.toHaveBeenCalled()
    expect(useSessionStore.getState().status).toBe('active')
  })

  test('a guest cannot forge session-full before any authority announcement', () => {
    const harness = fakeRoom()
    const localLeave = vi.fn(async () => {})
    beginActive(harness.room, localLeave)
    wireSessionRoom(harness.room, { isHost: false, leave: localLeave })

    harness.receiveSessionFull('forging-guest')

    expect(localLeave).not.toHaveBeenCalled()
    expect(useSessionStore.getState().status).toBe('active')
  })

  test('the old rejoin duration has no delayed survivor-side callback', async () => {
    const harness = fakeRoom()
    const localLeave = vi.fn(async () => {})
    beginActive(harness.room, localLeave)
    wireSessionRoom(harness.room, { isHost: true, leave: localLeave })

    harness.join('peer-a')
    harness.leave('peer-a')
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(REJOIN_WINDOW_MS * 3)

    expect(localLeave).not.toHaveBeenCalled()
    expect(useSessionStore.getState().pendingEndReason).toBeNull()
    expect(useSessionStore.getState().status).toBe('active')
  })
})
