import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('@/lib/trystero', () => {
  type Listener = (peerId: string) => void
  type Receiver = (data: unknown, peerId: string) => void
  type Bus = { rooms: Map<string, BusRoom> }
  type BusRoom = {
    peerId: string
    onJoin: Listener[]
    onLeave: Listener[]
    receivers: Map<string, Receiver[]>
    left: boolean
  }

  const buses = new Map<string, Bus>()
  const joinConfigs: Array<Record<string, unknown>> = []
  const events: Array<{ type: 'join' | 'leave'; topic: string }> = []
  let nextPeer = 0

  function getBus(key: string): Bus {
    let bus = buses.get(key)
    if (!bus) {
      bus = { rooms: new Map() }
      buses.set(key, bus)
    }
    return bus
  }

  function joinTopic(
    config: { topic: string; password: string } & Record<string, unknown>
  ) {
    joinConfigs.push(config)
    events.push({ type: 'join', topic: config.topic })
    const { topic, password } = config
    const key = `${topic}|${password}`
    const bus = getBus(key)
    const peerId = `peer-${++nextPeer}`
    const room: BusRoom = {
      peerId,
      onJoin: [],
      onLeave: [],
      receivers: new Map(),
      left: false,
    }
    bus.rooms.set(peerId, room)

    queueMicrotask(() => {
      if (room.left) return
      for (const other of bus.rooms.values()) {
        if (other === room || other.left) continue
        for (const fn of room.onJoin) fn(other.peerId)
        for (const fn of other.onJoin) fn(room.peerId)
      }
    })

    return {
      makeAction<T>(namespace: string) {
        const send = async (data: T): Promise<void[]> => {
          const promises: Promise<void>[] = []
          for (const other of bus.rooms.values()) {
            if (other === room || other.left) continue
            const handlers = other.receivers.get(namespace) ?? []
            for (const h of handlers) {
              promises.push(Promise.resolve().then(() => h(data, room.peerId)))
            }
          }
          await Promise.all(promises)
          return []
        }
        const receive = (cb: (data: T, peerId: string) => void) => {
          const list = room.receivers.get(namespace) ?? []
          list.push(cb as Receiver)
          room.receivers.set(namespace, list)
        }
        return { send, receive }
      },
      onPeerJoin: (fn: Listener) => {
        room.onJoin.push(fn)
        return () => {
          const i = room.onJoin.indexOf(fn)
          if (i >= 0) room.onJoin.splice(i, 1)
        }
      },
      onPeerLeave: (fn: Listener) => {
        room.onLeave.push(fn)
        return () => {
          const i = room.onLeave.indexOf(fn)
          if (i >= 0) room.onLeave.splice(i, 1)
        }
      },
      leave: async (): Promise<void> => {
        if (room.left) return
        room.left = true
        events.push({ type: 'leave', topic })
        bus.rooms.delete(peerId)
        for (const other of bus.rooms.values()) {
          for (const fn of other.onLeave) fn(peerId)
        }
      },
    }
  }

  return {
    joinTopic,
    __resetBus: () => {
      buses.clear()
      joinConfigs.length = 0
      events.length = 0
    },
    __getJoinConfigs: () => joinConfigs,
    __getEvents: () => events,
  }
})

import {
  boxDecrypt,
  boxEncrypt,
  bytesToHex,
  generateIdentity,
  hexToBytes,
  signMessage,
  type Identity,
} from '@/lib/crypto/identity'
import { inboxPassword, inboxTopic } from '@/lib/crypto/topics'
import { joinTopic } from '@/lib/trystero'
import {
  buildInviteEnvelope,
  INVITE_ACTION,
  inviteFriend,
  InviteRelayError,
  InviteTimeoutError,
  sendInviteEnvelope,
  subscribeToOwnInbox,
  validateInviteEnvelope,
  type InboxContext,
  type InviteEnvelope,
  type InviteSender,
  type ValidInvite,
} from '@/features/friends'

beforeEach(async () => {
  const mod = (await import('@/lib/trystero')) as unknown as {
    __resetBus: () => void
  }
  mod.__resetBus()
})

afterEach(() => {
  vi.useRealTimers()
})

type App = {
  identity: Identity
  edHex: string
  xHex: string
  displayName: string
  // Sender-side encrypt + sign closures, parallels what the production
  // keyring-backed Tauri commands do.
  sender: InviteSender
  // Receiver-side helpers.
  inboxCtx: (
    onValidInvite: (invite: ValidInvite) => void,
    knownFriends: ReadonlyArray<App>
  ) => InboxContext
}

function makeApp(displayName: string): App {
  const identity = generateIdentity()
  const edHex = bytesToHex(identity.edPub)
  const xHex = bytesToHex(identity.xPub)
  const sender: InviteSender = {
    edPubkeyHex: edHex,
    displayName,
    sign: async (msg) => signMessage(identity.edPriv, msg),
    encryptTo: async (theirXPub, plaintext) =>
      boxEncrypt(theirXPub, identity.xPriv, plaintext),
  }
  return {
    identity,
    edHex,
    xHex,
    displayName,
    sender,
    inboxCtx: (onValidInvite, knownFriends) => ({
      myEdPubkey: identity.edPub,
      lookupFriendXPub: (edPubkeyHex) => {
        const f = knownFriends.find((a) => a.edHex === edPubkeyHex)
        return f ? f.xHex : null
      },
      boxDecrypt: async (theirXPub, nonce, ciphertext) =>
        boxDecrypt(theirXPub, identity.xPriv, nonce, ciphertext),
      // #47 C2 — production passes signWithKeyring; the test signs in-process.
      signAck: async (msg) => signMessage(identity.edPriv, msg),
      onValidInvite,
    }),
  }
}

const SAMPLE_SESSION = {
  sessionTopic: 'session-topic-fixture',
  sessionPassword: 'session-password-fixture',
}

async function awaitInvite(
  app: App,
  expectedFromEdHex: string,
  knownFriends: ReadonlyArray<App>
): Promise<{
  receive: Promise<ValidInvite>
  leave: () => Promise<void>
}> {
  let resolveInvite!: (v: ValidInvite) => void
  const receive = new Promise<ValidInvite>((res) => {
    resolveInvite = res
  })
  const sub = subscribeToOwnInbox(
    app.inboxCtx((invite) => {
      if (invite.from_ed_pubkey === expectedFromEdHex) resolveInvite(invite)
    }, knownFriends)
  )
  return { receive, leave: sub.leave }
}

describe('invite envelope round-trip', () => {
  test('A pairs with B, A invites B, B decrypts + verifies + dispatches', async () => {
    const sam = makeApp('Sam')
    const alice = makeApp('Alice')

    const inbox = await awaitInvite(alice, sam.edHex, [sam])

    // #47 C2 — Alice's inbox answers with a signed delivery ACK, so Sam's
    // send resolves confirmed.
    const result = await inviteFriend(
      sam.sender,
      { edPubkeyHex: alice.edHex, xPubkeyHex: alice.xHex },
      SAMPLE_SESSION
    )
    expect(result.acked).toBe(true)

    const invite = await inbox.receive
    expect(invite.from_ed_pubkey).toBe(sam.edHex)
    expect(invite.payload.session_topic).toBe(SAMPLE_SESSION.sessionTopic)
    expect(invite.payload.session_password).toBe(SAMPLE_SESSION.sessionPassword)
    expect(invite.payload.our_display_name).toBe('Sam')
    expect(invite.payload.expires_at).toBeGreaterThan(Date.now())
    await inbox.leave()
  })

  test('non-friend C sending into B drops without decrypting', async () => {
    const carol = makeApp('Carol')
    const bob = makeApp('Bob')

    let decryptCount = 0
    let dispatched = 0
    const sub = subscribeToOwnInbox({
      myEdPubkey: bob.identity.edPub,
      lookupFriendXPub: () => null, // bob knows nobody
      boxDecrypt: async (...args) => {
        decryptCount++
        return boxDecrypt(args[0], bob.identity.xPriv, args[1], args[2])
      },
      onValidInvite: () => {
        dispatched++
      },
    })

    // #47 C2 — Bob's inbox drops the non-friend envelope without decrypting,
    // so no ACK ever comes back: exactly the "didn't add you back" case the
    // ack exists to surface. Short window so the test doesn't sit out the 5s
    // production default.
    const result = await inviteFriend(
      carol.sender,
      { edPubkeyHex: bob.edHex, xPubkeyHex: bob.xHex },
      SAMPLE_SESSION,
      { ackTimeoutMs: 50 }
    )
    expect(result.acked).toBe(false)
    // Settle scheduled microtasks.
    await new Promise((r) => setTimeout(r, 5))

    expect(decryptCount).toBe(0)
    expect(dispatched).toBe(0)
    await sub.leave()
  })

  test('tampered ciphertext is dropped', async () => {
    const sam = makeApp('Sam')
    const alice = makeApp('Alice')
    const envelope = await buildInviteEnvelope(
      sam.sender,
      { edPubkeyHex: alice.edHex, xPubkeyHex: alice.xHex },
      SAMPLE_SESSION
    )
    const ctBytes = atob(envelope.ciphertext)
    const arr = new Uint8Array(ctBytes.length)
    for (let i = 0; i < arr.length; i++) arr[i] = ctBytes.charCodeAt(i)
    arr[arr.length - 1] ^= 0x01
    let bin = ''
    for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i])
    const tampered = { ...envelope, ciphertext: btoa(bin) }

    const result = await validateInviteEnvelope(tampered, {
      lookupFriendXPub: () => sam.xHex,
      boxDecrypt: async (theirXPub, nonce, ct) =>
        boxDecrypt(theirXPub, alice.identity.xPriv, nonce, ct),
    })
    expect(result).toBeNull()
  })

  test('tampered nonce is dropped', async () => {
    const sam = makeApp('Sam')
    const alice = makeApp('Alice')
    const envelope = await buildInviteEnvelope(
      sam.sender,
      { edPubkeyHex: alice.edHex, xPubkeyHex: alice.xHex },
      SAMPLE_SESSION
    )
    const nonceBin = atob(envelope.nonce)
    const arr = new Uint8Array(nonceBin.length)
    for (let i = 0; i < arr.length; i++) arr[i] = nonceBin.charCodeAt(i)
    arr[0] ^= 0x01
    let bin = ''
    for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i])
    const tampered = { ...envelope, nonce: btoa(bin) }

    const result = await validateInviteEnvelope(tampered, {
      lookupFriendXPub: () => sam.xHex,
      boxDecrypt: async (theirXPub, nonce, ct) =>
        boxDecrypt(theirXPub, alice.identity.xPriv, nonce, ct),
    })
    expect(result).toBeNull()
  })

  test('tampered inner sig is dropped', async () => {
    const sam = makeApp('Sam')
    const alice = makeApp('Alice')

    // Forge a payload with a bad sig but a valid box (still signed by sam, but
    // we flip a bit in the sig hex inside the plaintext). To exercise this we
    // bypass buildInvitePayload's signMessage and inject a custom payload via
    // a one-off encryptTo that wraps a bad-sig payload into the box.
    const goodEnvelope = await buildInviteEnvelope(
      sam.sender,
      { edPubkeyHex: alice.edHex, xPubkeyHex: alice.xHex },
      SAMPLE_SESSION
    )
    // Decrypt the good envelope to recover the inner payload object, mutate
    // the sig, re-box it under sam's keys, then re-validate.
    const recipientXPub = hexToBytes(sam.xHex) // box "from" key on receiver side
    const nonceBin = atob(goodEnvelope.nonce)
    const ctBin = atob(goodEnvelope.ciphertext)
    const nonce = new Uint8Array(nonceBin.length)
    for (let i = 0; i < nonce.length; i++) nonce[i] = nonceBin.charCodeAt(i)
    const ct = new Uint8Array(ctBin.length)
    for (let i = 0; i < ct.length; i++) ct[i] = ctBin.charCodeAt(i)
    const plaintext = boxDecrypt(recipientXPub, alice.identity.xPriv, nonce, ct)
    const payload = JSON.parse(new TextDecoder().decode(plaintext))
    // Flip one hex char of sig.
    const sigHex = payload.sig as string
    const flipped =
      sigHex.slice(0, -2) + (sigHex.slice(-2) === '00' ? 'ff' : '00')
    payload.sig = flipped
    const mutatedPlaintext = new TextEncoder().encode(JSON.stringify(payload))
    const reBoxed = boxEncrypt(
      hexToBytes(alice.xHex),
      sam.identity.xPriv,
      mutatedPlaintext
    )
    const tamperedEnvelope = {
      v: 1 as const,
      from_ed_pubkey: sam.edHex,
      nonce: btoaFromBytes(reBoxed.nonce),
      ciphertext: btoaFromBytes(reBoxed.ciphertext),
    }

    const result = await validateInviteEnvelope(tamperedEnvelope, {
      lookupFriendXPub: () => sam.xHex,
      boxDecrypt: async (theirXPub, nonce_, ct_) =>
        boxDecrypt(theirXPub, alice.identity.xPriv, nonce_, ct_),
    })
    expect(result).toBeNull()
  })

  test('sendInviteEnvelope rejects with InviteTimeoutError when recipient never appears', async () => {
    const sam = makeApp('Sam')
    const alice = makeApp('Alice')
    const envelope = await buildInviteEnvelope(
      sam.sender,
      { edPubkeyHex: alice.edHex, xPubkeyHex: alice.xHex },
      SAMPLE_SESSION
    )
    // No `subscribeToOwnInbox` for alice → no peer ever joins sam's send room.
    // Relays are reachable (the friend is simply offline), so the timeout maps
    // to InviteTimeoutError, not InviteRelayError.
    await expect(
      sendInviteEnvelope(
        { edPubkeyHex: alice.edHex, xPubkeyHex: alice.xHex },
        envelope,
        { sendTimeoutMs: 50, isRelayUnreachable: () => false }
      )
    ).rejects.toBeInstanceOf(InviteTimeoutError)
  })

  test('F1/F6: sendInviteEnvelope rejects with InviteRelayError when no relay is reachable', async () => {
    const sam = makeApp('Sam')
    const alice = makeApp('Alice')
    const envelope = await buildInviteEnvelope(
      sam.sender,
      { edPubkeyHex: alice.edHex, xPubkeyHex: alice.xHex },
      SAMPLE_SESSION
    )
    // No subscriber for alice → no peer arrives → timeout fires. With the live
    // socket map reporting every relay unreachable, the timeout maps to
    // InviteRelayError (the user's own network) rather than InviteTimeoutError
    // (the friend is offline). This mirrors the real signal — trystero's
    // onJoinError never fires on blocked relays, so relay-down is read from the
    // socket map, injected here for determinism.
    await expect(
      sendInviteEnvelope(
        { edPubkeyHex: alice.edHex, xPubkeyHex: alice.xHex },
        envelope,
        { sendTimeoutMs: 50, isRelayUnreachable: () => true }
      )
    ).rejects.toBeInstanceOf(InviteRelayError)
  })

  test('expired invite is dropped', async () => {
    const sam = makeApp('Sam')
    const alice = makeApp('Alice')
    const envelope = await buildInviteEnvelope(
      sam.sender,
      { edPubkeyHex: alice.edHex, xPubkeyHex: alice.xHex },
      SAMPLE_SESSION,
      { ttlMs: 1, now: () => Date.now() - 60_000 }
    )

    const result = await validateInviteEnvelope(envelope, {
      lookupFriendXPub: () => sam.xHex,
      boxDecrypt: async (theirXPub, nonce, ct) =>
        boxDecrypt(theirXPub, alice.identity.xPriv, nonce, ct),
    })
    expect(result).toBeNull()
  })

  // Trystero's core dedupes rooms per (appId, topic): two concurrent sends
  // to the same friend used to share one raw room — the second's last-wins
  // listener registration deafened the first, and the first leave()
  // destroyed the room under the still-flying second (realistic trigger:
  // the F6 offline-retry auto-firing on a presence flip while the host
  // clicks Invite manually). Sends to one inbox topic are now serialized:
  // the second send's room must not open until the first's closed.
  test('concurrent sends to the same friend are serialized per inbox topic', async () => {
    const sam = makeApp('Sam')
    const alice = makeApp('Alice')
    const inviteArrived = await awaitInvite(alice, sam.edHex, [sam])
    const envelope = await buildInviteEnvelope(
      sam.sender,
      { edPubkeyHex: alice.edHex, xPubkeyHex: alice.xHex },
      SAMPLE_SESSION
    )
    const [r1, r2] = await Promise.all([
      sendInviteEnvelope(
        { edPubkeyHex: alice.edHex, xPubkeyHex: alice.xHex },
        envelope,
        { sendTimeoutMs: 1_000 }
      ),
      sendInviteEnvelope(
        { edPubkeyHex: alice.edHex, xPubkeyHex: alice.xHex },
        envelope,
        { sendTimeoutMs: 1_000 }
      ),
    ])
    expect(r1).toBeTruthy()
    expect(r2).toBeTruthy()
    await inviteArrived.receive
    const mod = (await import('@/lib/trystero')) as unknown as {
      __getEvents: () => Array<{ type: 'join' | 'leave'; topic: string }>
    }
    // Events on Alice's inbox topic: the subscriber's join, then strictly
    // send-join → send-leave → send-join → send-leave.
    const topicEvents = mod
      .__getEvents()
      .filter((e) => e.topic === inboxTopic(alice.identity.edPub))
    expect(topicEvents.map((e) => e.type)).toEqual([
      'join', // Alice's inbox subscriber
      'join',
      'leave',
      'join',
      'leave',
    ])
    await inviteArrived.leave()
  })

  // The inbox (receive) and per-send rooms carry invites over WebRTC
  // datachannels, so both must forward the user's TURN server — without it a
  // TURN-configured user on a strict NAT can neither receive invites nor have
  // a send's onPeerJoin ever fire (misreported as "friend may be offline").
  test('inbox and invite-send rooms forward the configured TURN server', async () => {
    const { useSettingsStore } = await import('@/stores/settingsStore')
    const prevValues = useSettingsStore.getState().values
    useSettingsStore.setState({
      values: {
        ...prevValues,
        turnPreference: 'auto',
        turnServer: {
          url: 'turn:turn.example.test:3478',
          username: 'u',
          credential: 'c',
        },
      },
    })
    try {
      const sam = makeApp('Sam')
      const alice = makeApp('Alice')
      const inviteArrived = await awaitInvite(alice, sam.edHex, [sam])
      const envelope = await buildInviteEnvelope(
        sam.sender,
        { edPubkeyHex: alice.edHex, xPubkeyHex: alice.xHex },
        SAMPLE_SESSION
      )
      await sendInviteEnvelope(
        { edPubkeyHex: alice.edHex, xPubkeyHex: alice.xHex },
        envelope,
        { sendTimeoutMs: 1_000 }
      )
      await inviteArrived.receive
      const mod = (await import('@/lib/trystero')) as unknown as {
        __getJoinConfigs: () => Array<Record<string, unknown>>
      }
      const configs = mod.__getJoinConfigs()
      expect(configs.length).toBeGreaterThanOrEqual(2)
      for (const config of configs) {
        expect(config.turnConfig).toEqual([
          {
            urls: 'turn:turn.example.test:3478',
            username: 'u',
            credential: 'c',
          },
        ])
      }
      await inviteArrived.leave()
    } finally {
      useSettingsStore.setState({ values: prevValues })
    }
  })

  // #47 C1 / PR-18 replay guard (inbox.ts:202-221). The inbox races Nostr +
  // MQTT, so one envelope is delivered twice on the SAME room — the everyday
  // path, not just the captured-envelope spam vector. The guard is the sole
  // idempotency mechanism (trystero/index.ts:240-245); without it a friend on
  // both transports gets a double toast + double OS notification per invite.
  // Two concurrent sends interleave across `await validateInviteEnvelope`, so
  // this is the only shape that catches an await slipping between the has/set
  // pair — sendInviteEnvelope serializes per inbox topic and never exercises
  // it.
  test('#47 C1: one envelope delivered twice on the same room fires onValidInvite once', async () => {
    const sam = makeApp('Sam')
    const alice = makeApp('Alice')
    const dispatched: ValidInvite[] = []
    const sub = subscribeToOwnInbox(
      alice.inboxCtx(
        (i) => {
          dispatched.push(i)
        },
        [sam]
      )
    )
    const envelope = await buildInviteEnvelope(
      sam.sender,
      { edPubkeyHex: alice.edHex, xPubkeyHex: alice.xHex },
      SAMPLE_SESSION
    )
    const room = joinTopic({
      topic: inboxTopic(alice.identity.edPub),
      password: inboxPassword(alice.identity.edPub),
    })
    const action = room.makeAction<InviteEnvelope>(INVITE_ACTION)
    await Promise.all([action.send(envelope), action.send(envelope)])
    await new Promise((r) => setTimeout(r, 50))
    expect(dispatched.length).toBe(1)
    await room.leave()
    await sub.leave()
  })

  // The replay key is (from_ed_pubkey, nonce), not from_ed_pubkey alone: two
  // genuinely distinct invites from the same friend must both dispatch. Pins
  // against an over-broad key that would swallow a legitimate second invite.
  test('two distinct-nonce invites from the same friend both dispatch', async () => {
    const sam = makeApp('Sam')
    const alice = makeApp('Alice')
    const dispatched: ValidInvite[] = []
    const sub = subscribeToOwnInbox(
      alice.inboxCtx(
        (i) => {
          dispatched.push(i)
        },
        [sam]
      )
    )
    const room = joinTopic({
      topic: inboxTopic(alice.identity.edPub),
      password: inboxPassword(alice.identity.edPub),
    })
    const action = room.makeAction<InviteEnvelope>(INVITE_ACTION)
    for (let i = 0; i < 2; i++) {
      const envelope = await buildInviteEnvelope(
        sam.sender,
        { edPubkeyHex: alice.edHex, xPubkeyHex: alice.xHex },
        SAMPLE_SESSION
      )
      await action.send(envelope)
    }
    await new Promise((r) => setTimeout(r, 50))
    expect(dispatched.length).toBe(2)
    await room.leave()
    await sub.leave()
  })
})

function btoaFromBytes(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}
