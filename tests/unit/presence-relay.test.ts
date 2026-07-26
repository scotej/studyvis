// I74 — startPresenceRelay glue: seal → publish → route → open, over a fake
// pool. The full socket behavior lives in nostr-pool.test.ts; the
// presence.ts integration in presence.test.ts.

import { describe, expect, test } from 'vitest'

import { startPresenceRelay } from '@/features/friends/presenceRelay'
import type { RelayPresencePayload } from '@/lib/nostr/events'
import {
  openPresencePayload,
  PRESENCE_EVENT_KIND,
  sealPresencePayload,
  type NostrEvent,
} from '@/lib/nostr/events'
import { generateIdentity, bytesToHex } from '@/lib/crypto/identity'
import { presenceRelayKey, presenceRelayTag } from '@/lib/crypto/topics'
import type { RelayPoolConfig } from '@/lib/nostr/pool'

type Harness = {
  published: NostrEvent[]
  publishedHere: NostrEvent[]
  subscriptions: string[][]
  closed: boolean
  config: RelayPoolConfig
  received: Array<[string, RelayPresencePayload]>
}

function makeHarness(opts?: { openSynchronously?: boolean }) {
  const me = generateIdentity()
  const friend = generateIdentity()
  const state: Partial<Harness> = {
    published: [],
    publishedHere: [],
    subscriptions: [],
    closed: false,
    received: [],
  }
  const handle = startPresenceRelay({
    myEdPubkey: me.edPub,
    onFriendPayload: (edHex, payload) => state.received!.push([edHex, payload]),
    makePool: (config) => {
      state.config = config
      // A pool whose socket is already open when constructed — the callback
      // must be safe to invoke synchronously from inside the factory.
      if (opts?.openSynchronously) {
        config.onSocketOpen?.((event) => state.publishedHere!.push(event))
      }
      return {
        setSubscription: (tags) => state.subscriptions!.push([...tags]),
        publish: (event) => state.published!.push(event),
        close: () => {
          state.closed = true
        },
      }
    },
  })
  return { handle, state: state as Harness, me, friend }
}

describe('startPresenceRelay', () => {
  test('heartbeat and goodbye publish sealed events on MY tag that friends can open', () => {
    const { handle, state, me } = makeHarness()
    handle.publishHeartbeat()
    handle.publishGoodbye()
    expect(state.published.length).toBe(2)
    const myKey = presenceRelayKey(me.edPub)
    const myTag = presenceRelayTag(me.edPub)
    for (const event of state.published) {
      expect(event.kind).toBe(PRESENCE_EVENT_KIND)
      expect(event.tags).toEqual([['x', myTag]])
    }
    expect(openPresencePayload(myKey, state.published[0].content)).toEqual({
      v: 1,
    })
    expect(openPresencePayload(myKey, state.published[1].content)).toEqual({
      v: 1,
      leaving: true,
    })
  })

  test('setFriends subscribes friend tags and inbound events route by tag', () => {
    const { handle, state, friend } = makeHarness()
    const friendHex = bytesToHex(friend.edPub)
    handle.setFriends([friendHex, 'not-hex!!'])
    const friendTag = presenceRelayTag(friend.edPub)
    expect(state.subscriptions.at(-1)).toEqual([friendTag])

    const friendKey = presenceRelayKey(friend.edPub)
    state.config.onEvent(friendTag, sealPresencePayload(friendKey, { v: 1 }))
    expect(state.received).toEqual([[friendHex, { v: 1 }]])

    // Unknown tag and garbage content are dropped.
    state.config.onEvent('unknown-tag', 'whatever')
    state.config.onEvent(friendTag, 'not sealed')
    expect(state.received.length).toBe(1)
  })

  test('a synchronously-opening pool gets an immediate scoped heartbeat', () => {
    const { state, me } = makeHarness({ openSynchronously: true })
    expect(state.publishedHere.length).toBe(1)
    expect(
      openPresencePayload(
        presenceRelayKey(me.edPub),
        state.publishedHere[0].content
      )
    ).toEqual({ v: 1 })
  })

  test('close closes the pool', () => {
    const { handle, state } = makeHarness()
    handle.close()
    expect(state.closed).toBe(true)
  })
})
