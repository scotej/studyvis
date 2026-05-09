import { verifyMessage } from '@/lib/crypto/identity'
import { inboxPassword, inboxTopic } from '@/lib/crypto/topics'
import { base64ToBytes, hexToBytes } from '@/lib/encoding'
import { joinTopic, type TopicRoom } from '@/lib/trystero'

import {
  INVITE_ACTION,
  INVITE_ENVELOPE_VERSION,
  serializePayloadForSig,
  type InviteEnvelope,
  type InvitePayload,
} from './envelope'

// Resolves to the friend's x_pubkey (hex) given their ed_pubkey (hex), or null
// if they're not a known friend. Lets the caller hot-path a store cache and
// fall back to a DB lookup on miss.
export type FriendXPubLookup = (
  edPubkeyHex: string
) => string | null | Promise<string | null>

// Decrypts the box body using the recipient's X25519 private key. Returns the
// inner payload bytes. Implementations live in src/lib/db/identity.ts
// (boxDecryptWithKeyring → identity_box_decrypt Tauri command) so the JS layer
// never touches the X25519 private key. Tests inject a closure that reaches
// into known-private-key bytes directly.
export type BoxDecryptFn = (
  theirXPub: Uint8Array,
  nonce: Uint8Array,
  ciphertext: Uint8Array
) => Promise<Uint8Array>

export type ValidInvite = {
  from_ed_pubkey: string
  payload: InvitePayload
}

export type InboxContext = {
  myEdPubkey: Uint8Array
  lookupFriendXPub: FriendXPubLookup
  boxDecrypt: BoxDecryptFn
  onValidInvite: (invite: ValidInvite) => void
  now?: () => number
}

export type InboxSubscription = {
  leave: () => Promise<void>
}

// Returns true iff the envelope is well-shaped at the wire level. Caller still
// has to do friend-lookup + decrypt + sig + expiry checks. Out-of-shape
// envelopes are dropped silently — fingerprinting hazard otherwise.
function isInviteEnvelope(value: unknown): value is InviteEnvelope {
  if (!value || typeof value !== 'object') return false
  const v = value as Partial<InviteEnvelope>
  return (
    v.v === INVITE_ENVELOPE_VERSION &&
    typeof v.from_ed_pubkey === 'string' &&
    typeof v.nonce === 'string' &&
    typeof v.ciphertext === 'string'
  )
}

function isInvitePayload(value: unknown): value is InvitePayload {
  if (!value || typeof value !== 'object') return false
  const v = value as Partial<InvitePayload>
  return (
    typeof v.session_topic === 'string' &&
    typeof v.session_password === 'string' &&
    typeof v.our_display_name === 'string' &&
    typeof v.expires_at === 'number' &&
    typeof v.sig === 'string'
  )
}

export async function validateInviteEnvelope(
  envelope: unknown,
  ctx: Pick<InboxContext, 'lookupFriendXPub' | 'boxDecrypt' | 'now'>
): Promise<ValidInvite | null> {
  if (!isInviteEnvelope(envelope)) return null

  // Step 1: friend-list lookup BEFORE decrypt cost (§6 step 9). A throwing
  // lookup (DB read error, etc.) becomes a silent drop — same threat-model
  // bucket as a non-friend envelope, and avoids an unhandled rejection
  // bubbling out of the receive callback.
  let senderXPubHex: string | null
  try {
    senderXPubHex = await ctx.lookupFriendXPub(envelope.from_ed_pubkey)
  } catch {
    return null
  }
  if (!senderXPubHex) return null

  // Step 2: decode wire bytes.
  let senderXPub: Uint8Array
  let senderEdPub: Uint8Array
  let nonce: Uint8Array
  let ciphertext: Uint8Array
  try {
    senderXPub = hexToBytes(senderXPubHex)
    senderEdPub = hexToBytes(envelope.from_ed_pubkey)
    nonce = base64ToBytes(envelope.nonce)
    ciphertext = base64ToBytes(envelope.ciphertext)
  } catch {
    return null
  }
  if (senderXPub.length !== 32 || senderEdPub.length !== 32) return null
  if (nonce.length !== 24) return null

  // Step 3: NaCl-box decrypt with our X25519 private key.
  let plaintext: Uint8Array
  try {
    plaintext = await ctx.boxDecrypt(senderXPub, nonce, ciphertext)
  } catch {
    return null
  }

  // Step 4: parse JSON payload.
  let payload: unknown
  try {
    payload = JSON.parse(new TextDecoder().decode(plaintext))
  } catch {
    return null
  }
  if (!isInvitePayload(payload)) return null

  // Step 5: verify the inner Ed25519 sig over (payload without sig field).
  let sig: Uint8Array
  try {
    sig = hexToBytes(payload.sig)
  } catch {
    return null
  }
  if (sig.length !== 64) return null
  const signed = serializePayloadForSig({
    session_topic: payload.session_topic,
    session_password: payload.session_password,
    our_display_name: payload.our_display_name,
    expires_at: payload.expires_at,
  })
  if (!verifyMessage(senderEdPub, signed, sig)) return null

  // Step 6: expiry check.
  const now = ctx.now ? ctx.now() : Date.now()
  if (payload.expires_at <= now) return null

  return { from_ed_pubkey: envelope.from_ed_pubkey, payload }
}

export function subscribeToOwnInbox(ctx: InboxContext): InboxSubscription {
  const room: TopicRoom = joinTopic({
    topic: inboxTopic(ctx.myEdPubkey),
    password: inboxPassword(ctx.myEdPubkey),
  })
  const action = room.makeAction<InviteEnvelope>(INVITE_ACTION)

  action.receive((data) => {
    void (async () => {
      const valid = await validateInviteEnvelope(data, ctx)
      if (valid) ctx.onValidInvite(valid)
    })()
  })

  return {
    leave: () => room.leave(),
  }
}
