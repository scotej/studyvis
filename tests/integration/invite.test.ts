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
  let nextPeer = 0

  function getBus(key: string): Bus {
    let bus = buses.get(key)
    if (!bus) {
      bus = { rooms: new Map() }
      buses.set(key, bus)
    }
    return bus
  }

  function joinTopic({ topic, password }: { topic: string; password: string }) {
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
      },
      onPeerLeave: (fn: Listener) => {
        room.onLeave.push(fn)
      },
      leave: async (): Promise<void> => {
        if (room.left) return
        room.left = true
        bus.rooms.delete(peerId)
        for (const other of bus.rooms.values()) {
          for (const fn of other.onLeave) fn(peerId)
        }
      },
    }
  }

  return { joinTopic, __resetBus: () => buses.clear() }
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
import {
  buildInviteEnvelope,
  inviteFriend,
  subscribeToOwnInbox,
  validateInviteEnvelope,
  type InboxContext,
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

    await inviteFriend(
      sam.sender,
      { edPubkeyHex: alice.edHex, xPubkeyHex: alice.xHex },
      SAMPLE_SESSION
    )

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

    await inviteFriend(
      carol.sender,
      { edPubkeyHex: bob.edHex, xPubkeyHex: bob.xHex },
      SAMPLE_SESSION
    )
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
})

function btoaFromBytes(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}
