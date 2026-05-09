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

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export const INVITE_ENVELOPE_VERSION = 1 as const
export const INVITE_TTL_MS = 5 * 60 * 1000 // 5 minutes per ARCHITECTURE §6
export const INVITE_ACTION = 'invite'
