import { verifyMessage } from '@/lib/crypto/identity'
import { bytesToHex, hexToBytes } from '@/lib/encoding'
import type { TopicAction } from '@/lib/trystero'

export const DIRECT_MESSAGE_ACTION = 'session-direct-message'
export const DIRECT_MESSAGE_VERSION = 1 as const
export const DIRECT_MESSAGE_MAX_LENGTH = 500

const ED25519_PUBLIC_KEY_HEX_LENGTH = 64
const ED25519_SIGNATURE_HEX_LENGTH = 128

export type DirectMessageCore = {
  v: typeof DIRECT_MESSAGE_VERSION
  session_topic: string
  from_ed_pubkey: string
  to_ed_pubkey: string
  text: string
  ts: number
}

export type DirectMessagePayload = DirectMessageCore & { sig: string }

function isExactHex(value: string, length: number): boolean {
  return value.length === length && /^[0-9a-f]+$/i.test(value)
}

export function serializeDirectMessageForSig(
  core: DirectMessageCore
): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      v: core.v,
      session_topic: core.session_topic,
      from_ed_pubkey: core.from_ed_pubkey,
      to_ed_pubkey: core.to_ed_pubkey,
      text: core.text,
      ts: core.ts,
    })
  )
}

export async function buildDirectMessagePayload(args: {
  sessionTopic: string
  myEdPubkeyHex: string
  recipientEdPubkeyHex: string
  text: string
  sign: (message: Uint8Array) => Promise<Uint8Array>
  now?: () => number
}): Promise<DirectMessagePayload> {
  const text = args.text.trim().slice(0, DIRECT_MESSAGE_MAX_LENGTH)
  if (!text) throw new TypeError('direct message text must not be empty')
  if (
    !isExactHex(args.myEdPubkeyHex, ED25519_PUBLIC_KEY_HEX_LENGTH) ||
    !isExactHex(args.recipientEdPubkeyHex, ED25519_PUBLIC_KEY_HEX_LENGTH)
  ) {
    throw new TypeError('direct message public keys must be 32-byte hex values')
  }

  const ts = args.now ? args.now() : Date.now()
  if (!Number.isFinite(ts)) {
    throw new RangeError('direct message timestamp must be finite')
  }

  const core: DirectMessageCore = {
    v: DIRECT_MESSAGE_VERSION,
    session_topic: args.sessionTopic,
    from_ed_pubkey: args.myEdPubkeyHex,
    to_ed_pubkey: args.recipientEdPubkeyHex,
    text,
    ts,
  }
  const signature = await args.sign(serializeDirectMessageForSig(core))
  if (signature.length * 2 !== ED25519_SIGNATURE_HEX_LENGTH) {
    throw new RangeError('direct message signature must be 64 bytes')
  }
  return { ...core, sig: bytesToHex(signature) }
}

export async function sendDirectMessageToPeer(
  action: Pick<TopicAction<DirectMessagePayload>, 'send'>,
  payload: DirectMessagePayload,
  recipientPeerId: string
): Promise<void> {
  if (!recipientPeerId.trim()) {
    throw new TypeError('direct message recipient peer ID must not be empty')
  }
  await action.send(payload, recipientPeerId)
}

export function verifyIncomingDirectMessage(
  data: unknown,
  expectedSenderEdPubkeyHex: string | null,
  myEdPubkeyHex: string,
  sessionTopic: string
): DirectMessagePayload | null {
  if (!data || typeof data !== 'object') return null
  const value = data as Partial<DirectMessagePayload>
  if (
    value.v !== DIRECT_MESSAGE_VERSION ||
    typeof value.session_topic !== 'string' ||
    typeof value.from_ed_pubkey !== 'string' ||
    typeof value.to_ed_pubkey !== 'string' ||
    typeof value.text !== 'string' ||
    typeof value.ts !== 'number' ||
    typeof value.sig !== 'string'
  ) {
    return null
  }
  if (
    value.text.trim().length === 0 ||
    value.text.length > DIRECT_MESSAGE_MAX_LENGTH ||
    !Number.isFinite(value.ts) ||
    !expectedSenderEdPubkeyHex ||
    !isExactHex(expectedSenderEdPubkeyHex, ED25519_PUBLIC_KEY_HEX_LENGTH) ||
    !isExactHex(myEdPubkeyHex, ED25519_PUBLIC_KEY_HEX_LENGTH) ||
    !isExactHex(value.from_ed_pubkey, ED25519_PUBLIC_KEY_HEX_LENGTH) ||
    !isExactHex(value.to_ed_pubkey, ED25519_PUBLIC_KEY_HEX_LENGTH) ||
    value.sig.length !== ED25519_SIGNATURE_HEX_LENGTH ||
    value.from_ed_pubkey !== expectedSenderEdPubkeyHex ||
    value.to_ed_pubkey !== myEdPubkeyHex ||
    value.session_topic !== sessionTopic
  ) {
    return null
  }

  let senderEdPubkey: Uint8Array
  let signature: Uint8Array
  try {
    senderEdPubkey = hexToBytes(value.from_ed_pubkey)
    signature = hexToBytes(value.sig)
  } catch {
    return null
  }

  const signed = serializeDirectMessageForSig({
    v: value.v,
    session_topic: value.session_topic,
    from_ed_pubkey: value.from_ed_pubkey,
    to_ed_pubkey: value.to_ed_pubkey,
    text: value.text,
    ts: value.ts,
  })
  return verifyMessage(senderEdPubkey, signed, signature)
    ? (value as DirectMessagePayload)
    : null
}
