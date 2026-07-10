// Wire shape for an invite envelope landed in a recipient's inbox topic.
// `from_ed_pubkey`, `nonce`, and `ciphertext` live OUTSIDE the box so the
// receiver can do a friend-list lookup before paying ECDH cost (ARCHITECTURE
// §6 step 5). Everything else is inside the NaCl-box ciphertext.
export type InviteEnvelope = {
  v: 1
  from_ed_pubkey: string // hex(32)
  nonce: string // base64(24)
  ciphertext: string // base64
}

// Inner payload, recovered after box-decrypt. The signature covers
// the payload-without-sig, serialized via `serializePayloadForSig`.
export type InvitePayload = {
  session_topic: string
  session_password: string
  our_display_name: string
  expires_at: number
  sig: string // hex(64)
}

export type InvitePayloadCore = Omit<InvitePayload, 'sig'>

// CRITICAL: this serialization is the bytes-being-signed AND the bytes
// the receiver re-serializes for verification. Both sides must round-trip
// to the same bytes — JSON key order, whitespace, and field selection
// are pinned here. Never inline an alternative.
export function serializePayloadForSig(p: InvitePayloadCore): Uint8Array {
  const canonical = JSON.stringify({
    session_topic: p.session_topic,
    session_password: p.session_password,
    our_display_name: p.our_display_name,
    expires_at: p.expires_at,
  })
  return new TextEncoder().encode(canonical)
}

export const INVITE_ENVELOPE_VERSION = 1 as const
export const INVITE_TTL_MS = 5 * 60 * 1000 // 5 minutes per ARCHITECTURE §6
export const INVITE_ACTION = 'invite'

// #47 C2 — signed invite-delivery ACK (the hardening ISSUES.md I46 flagged
// as future work, shipped for UX legibility: with one-directional
// ContactCard adds, a friend who never added you back silently drops your
// envelopes while you see "Invite sent"). A NEW action on the same inbox
// topic, so the v1.2.x wire is untouched — older builds never register it
// and the sender falls back to unconfirmed copy on the ack timeout. The ACK
// is signed by the RECIPIENT so a stranger on the (public-derivable) inbox
// topic can't forge a confirmation; it deliberately proves delivery only —
// I46's accepted eavesdropper concern stands.
export const INVITE_ACK_ACTION = 'invite-ack'
export const INVITE_ACK_VERSION = 1 as const

export type InviteAckCore = {
  session_topic: string
  // The inviter this ack answers (their ed pubkey, hex).
  to_ed_pubkey: string
  ts: number
}

export type InviteAck = InviteAckCore & {
  v: typeof INVITE_ACK_VERSION
  // The recipient/signer (ed pubkey, hex).
  from_ed_pubkey: string
  sig: string // hex(64)
}

// Canonical bytes the ack signature covers — fixed key order, mirroring
// serializePayloadForSig below (the single-canonical-bytes convention).
export function serializeAckForSig(core: InviteAckCore): Uint8Array {
  const canonical = JSON.stringify({
    session_topic: core.session_topic,
    to_ed_pubkey: core.to_ed_pubkey,
    ts: core.ts,
  })
  return new TextEncoder().encode(canonical)
}
