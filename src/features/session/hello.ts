// Signed-hello handshake. Each peer broadcasts a signed hello when they join
// the session room, binding their trystero `peerId` to their Ed25519 pubkey.
// Receivers verify the signature against the sender's claimed ed_pubkey AND
// re-bind via the actual sender peerId from the receive callback — so a
// stranger cannot claim someone else's pubkey on the wire.
//
// This unblocks the V1-P8 carryover: audit-log signature verification (the
// receiver looks up the sender peerId in the populated map) and the
// sessions.peer_pubkeys column (a sorted JSON array of every binding seen).

import { verifyMessage } from '@/lib/crypto/identity'
import { hexToBytes } from '@/lib/encoding'
import type { TopicRoom } from '@/lib/trystero'

export const HELLO_ACTION = 'session-hello'
export const HELLO_VERSION = 1 as const

export type HelloCore = {
  v: typeof HELLO_VERSION
  peer_id: string
  ed_pubkey_hex: string
  display_name: string
  joined_at: number
}

export type HelloPayload = HelloCore & { sig: string }

// Re-exported under `Hello` for callers in this feature; identical shape to
// `PeerHello` in sessionStore (kept in sync — sessionStore.ts is the
// canonical inline declaration so the store has no feature-layer import).
export type Hello = {
  ed_pubkey_hex: string
  display_name: string
  joined_at: number
}

// Canonical bytes the sender signs and the receiver re-serializes for
// verification. Identical to envelope.serializePayloadForSig in spirit; key
// order and whitespace are pinned so the round-trip is byte-stable.
export function serializeHelloForSig(core: HelloCore): Uint8Array {
  const canonical = JSON.stringify({
    v: core.v,
    peer_id: core.peer_id,
    ed_pubkey_hex: core.ed_pubkey_hex,
    display_name: core.display_name,
    joined_at: core.joined_at,
  })
  return new TextEncoder().encode(canonical)
}

function isHelloPayload(value: unknown): value is HelloPayload {
  if (!value || typeof value !== 'object') return false
  const v = value as Partial<HelloPayload>
  return (
    v.v === HELLO_VERSION &&
    typeof v.peer_id === 'string' &&
    typeof v.ed_pubkey_hex === 'string' &&
    typeof v.display_name === 'string' &&
    typeof v.joined_at === 'number' &&
    typeof v.sig === 'string'
  )
}

// Returns a validated Hello iff the sender peerId on the wire matches the
// `peer_id` claimed in the signed payload AND the Ed25519 sig over
// canonical-bytes verifies. Anything else returns null and the caller drops.
export function validateHelloPayload(
  data: unknown,
  senderPeerId: string
): Hello | null {
  if (!isHelloPayload(data)) return null
  if (data.peer_id !== senderPeerId) return null

  let edPub: Uint8Array
  let sig: Uint8Array
  try {
    edPub = hexToBytes(data.ed_pubkey_hex)
    sig = hexToBytes(data.sig)
  } catch {
    return null
  }
  if (edPub.length !== 32 || sig.length !== 64) return null

  const signed = serializeHelloForSig({
    v: data.v,
    peer_id: data.peer_id,
    ed_pubkey_hex: data.ed_pubkey_hex,
    display_name: data.display_name,
    joined_at: data.joined_at,
  })
  if (!verifyMessage(edPub, signed, sig)) return null

  return {
    ed_pubkey_hex: data.ed_pubkey_hex,
    display_name: data.display_name,
    joined_at: data.joined_at,
  }
}

export type HelloProtocolArgs = {
  room: TopicRoom
  myEdPubkeyHex: string
  myDisplayName: string
  selfJoinedAt: number
  sign: (bytes: Uint8Array) => Promise<Uint8Array>
  onPeerHello: (peerId: string, hello: Hello) => void
  onPeerLeave: (peerId: string) => void
}

export type HelloProtocolHandle = {
  // Resolves once the hello has been broadcast to all currently-connected
  // peers. Callers (e.g. the audit "joined" emit) await this to ensure
  // recipients have the peerId↔ed_pubkey binding before the first signed
  // event arrives.
  ourHelloSent: Promise<void>
  teardown: () => void
}

// Wires hello-send (on every peer-join) and hello-receive (validate + map).
// Trystero's per-channel ordering on a single underlying RTCDataChannel means
// awaiting `ourHelloSent` before the first audit broadcast guarantees the
// hello arrives first at every recipient — see advisor note #3 + ARCHITECTURE
// §7's data-channel ordering assumption.
export function startHelloProtocol(
  args: HelloProtocolArgs
): HelloProtocolHandle {
  const action = args.room.makeAction<HelloPayload>(HELLO_ACTION)

  const buildPayload = async (): Promise<HelloPayload> => {
    const core: HelloCore = {
      v: HELLO_VERSION,
      peer_id: args.room.selfId,
      ed_pubkey_hex: args.myEdPubkeyHex,
      display_name: args.myDisplayName,
      joined_at: args.selfJoinedAt,
    }
    const sig = await args.sign(serializeHelloForSig(core))
    let sigHex = ''
    for (let i = 0; i < sig.length; i++) {
      sigHex += sig[i].toString(16).padStart(2, '0')
    }
    return { ...core, sig: sigHex }
  }

  // Builds once; reused for every peer (broadcast + targeted re-send to
  // each new peer that joins after us).
  const payloadPromise = buildPayload()

  // Broadcast to whoever's already on the topic. trystero's send awaits
  // every recipient's data channel buffer drain, so by the time this
  // resolves, the hello has been written to all current peers in order.
  const ourHelloSent = (async () => {
    const payload = await payloadPromise
    await action.send(payload)
  })()

  // For peers who join after us, send a targeted hello so they get the
  // binding immediately rather than after our next broadcast (there is none —
  // hello is one-shot per peer).
  const offJoin = args.room.onPeerJoin((peerId) => {
    void (async () => {
      const payload = await payloadPromise
      try {
        await action.send(payload, peerId)
      } catch {
        // best-effort; the joiner will silently lack our binding and ignore
        // our subsequent audit events. Acceptable in friends-only mode.
      }
    })()
  })

  action.receive((data, peerId) => {
    const hello = validateHelloPayload(data, peerId)
    if (!hello) return
    args.onPeerHello(peerId, hello)
  })

  const offLeave = args.room.onPeerLeave((peerId) => {
    args.onPeerLeave(peerId)
  })

  return {
    ourHelloSent,
    teardown: () => {
      offJoin()
      offLeave()
    },
  }
}
