import { verifyMessage } from '@/lib/crypto/identity'
import { inboxPassword, inboxTopic } from '@/lib/crypto/topics'
import { base64ToBytes, bytesToHex, hexToBytes } from '@/lib/encoding'
import { joinTopic, type TopicRoom } from '@/lib/trystero'
import { userRelayConfig } from '@/lib/trystero/relays'

import {
  INVITE_ACK_ACTION,
  INVITE_ACK_VERSION,
  INVITE_ACTION,
  INVITE_ENVELOPE_VERSION,
  INVITE_TTL_MS,
  serializeAckForSig,
  serializePayloadForSig,
  type InviteAck,
  type InviteAckCore,
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
  // #47 C2 — when present, each validated invite is answered with a signed
  // delivery ACK on this same inbox topic, targeted at the delivering peer.
  // Optional so the ack capability degrades to the pre-C2 wire (no ack) when
  // signing is unavailable.
  signAck?: (message: Uint8Array) => Promise<Uint8Array>
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
  // F3 — `joinTopic` constructs the relay WebSockets synchronously, so a
  // malformed saved relay URL (one that slipped past validation, e.g. a
  // hand-edited settings.json) throws here. This runs in InboxBoot's mount
  // effect, which has no React error boundary above it, so an unguarded throw
  // would blank the whole app at launch. Swallow it: a dead inbox subscriber
  // is a degraded-but-running app; the user can still reach Settings → Network
  // to fix the relay list.
  let room: TopicRoom
  try {
    room = joinTopic({
      topic: inboxTopic(ctx.myEdPubkey),
      password: inboxPassword(ctx.myEdPubkey),
      relayConfig: userRelayConfig(),
      // #47 C1 — race Nostr + MQTT so a friend on a Nostr-blocked network can
      // still deliver invites. Duplicate delivery of one envelope over both
      // transports is absorbed by the PR-18 (from, nonce) replay guard below.
      strategies: ['nostr', 'mqtt'],
      // F1 — the inbox is a long-lived background subscriber with no dialog to
      // drive, so a join error is logged for diagnostics only. A real relay
      // outage surfaces to the user through the pairing/invite flows instead.
      onJoinError: (details) =>
        console.warn('inbox room join error:', details.error),
    })
  } catch (err) {
    console.error('inbox room join failed:', err)
    return { leave: async () => {} }
  }
  const action = room.makeAction<InviteEnvelope>(INVITE_ACTION)
  // #47 C2 — the delivery-ack sender. Created unconditionally (cheap); only
  // used when ctx.signAck is provided.
  const ackAction = room.makeAction<InviteAck>(INVITE_ACK_ACTION)
  const myEdPubkeyHex = bytesToHex(ctx.myEdPubkey)

  // PR-18 — replay guard. The inbox topic + password derive solely from the
  // recipient's PUBLIC ed pubkey (topics.ts), so a stranger holding a contact
  // card can join this topic and re-broadcast a captured, still-unexpired
  // envelope to re-fire the invite toast + OS notification (prompt spam). The
  // NaCl-box nonce is unique per envelope, so (from_ed_pubkey, nonce) uniquely
  // identifies one invite; drop repeats. Kept only until the invite TTL, after
  // which validateInviteEnvelope's expiry check drops the envelope anyway.
  const seen = new Map<string, number>()
  action.receive((data, peerId) => {
    void (async () => {
      const valid = await validateInviteEnvelope(data, ctx)
      if (!valid) return
      const now = ctx.now ? ctx.now() : Date.now()
      for (const [key, seenAt] of seen) {
        if (now - seenAt > INVITE_TTL_MS) seen.delete(key)
      }
      const replayKey = `${valid.from_ed_pubkey}:${data.nonce}`
      if (seen.has(replayKey)) return
      seen.set(replayKey, now)
      ctx.onValidInvite(valid)
      // #47 C2 — answer with a signed delivery ACK, targeted at the peer that
      // delivered the envelope (the inviter is still on our inbox topic
      // awaiting it). Best-effort: an ack failure must never affect the
      // invite itself; replay-dropped envelopes above are deliberately NOT
      // acked (they're suppressed as spam).
      if (!ctx.signAck) return
      const core: InviteAckCore = {
        session_topic: valid.payload.session_topic,
        to_ed_pubkey: valid.from_ed_pubkey,
        ts: now,
      }
      try {
        const sig = await ctx.signAck(serializeAckForSig(core))
        const ack: InviteAck = {
          v: INVITE_ACK_VERSION,
          from_ed_pubkey: myEdPubkeyHex,
          ...core,
          sig: bytesToHex(sig),
        }
        void ackAction.send(ack, peerId).catch(() => {})
      } catch {
        // ack is best-effort
      }
    })()
  })

  return {
    leave: () => room.leave(),
  }
}
