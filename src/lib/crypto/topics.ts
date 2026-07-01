import { sha256 } from '@noble/hashes/sha2.js'

import { bytesToBase64, bytesToHex, hexToBytes } from '@/lib/encoding'

const enc = new TextEncoder()

function digestHex(label: string, payload: string): string {
  return bytesToHex(sha256(enc.encode(label + payload)))
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const len = Math.min(a.length, b.length)
  for (let i = 0; i < len; i++) {
    if (a[i] !== b[i]) return a[i] - b[i]
  }
  return a.length - b.length
}

// Safety number for offline ContactCard pairing (and shown post-hello on the
// legacy live path). A symmetric function of BOTH parties' ed25519 pubkeys —
// sorting the raw key bytes makes it order-independent so each side computes the
// identical value. Rendered as 20 decimal digits in four groups so two friends
// can read it aloud over an INDEPENDENT channel (a call, across a desk) to catch
// a man-in-the-middle who minted their own card. Covers ed keys only: the card's
// self-signature already binds x25519 to ed, so authenticating ed is sufficient
// — widen this to include x if that binding ever weakens.
export function pairFingerprint(edAHex: string, edBHex: string): string {
  const a = hexToBytes(edAHex)
  const b = hexToBytes(edBHex)
  const [lo, hi] = compareBytes(a, b) <= 0 ? [a, b] : [b, a]
  const concat = new Uint8Array(lo.length + hi.length)
  concat.set(lo, 0)
  concat.set(hi, lo.length)
  const digest = sha256(
    enc.encode('studyvis:pair-fp:v1:' + bytesToBase64(concat))
  )
  let n = 0n
  for (let i = 0; i < 8; i++) n = (n << 8n) | BigInt(digest[i])
  const digits = n.toString().padStart(20, '0')
  return `${digits.slice(0, 5)} ${digits.slice(5, 10)} ${digits.slice(10, 15)} ${digits.slice(15, 20)}`
}

// A short, deterministic tag off an ed pubkey for disambiguating friends who
// chose the same display name (names aren't unique; the ed key is the identity).
// NOT a security control — the safety number above is. Just the key's own prefix.
export function shortEdFingerprint(edHex: string): string {
  return edHex.slice(0, 8).toLowerCase()
}

export function inboxTopic(edPubkey: Uint8Array): string {
  return digestHex('studyvis:inbox:v1:', bytesToBase64(edPubkey))
}

export function inboxPassword(edPubkey: Uint8Array): string {
  return digestHex('studyvis:inbox-pw:v1:', bytesToBase64(edPubkey))
}

export function pairTopic(words: string[]): string {
  return digestHex('studyvis:pair:v1:', words.join('-'))
}

export function pairPassword(words: string[]): string {
  return digestHex('studyvis:pair-pw:v1:', words.join('-'))
}

export function sessionTopic(sessionId: Uint8Array): string {
  return digestHex('studyvis:session:v1:', bytesToHex(sessionId))
}

// Presence channel — kept distinct from inbox so heartbeat traffic doesn't
// drown invite traffic, and so a friend who is online for presence is not
// silently "online for invites" if the receive path crashes after subscribe.
export function presenceTopic(edPubkey: Uint8Array): string {
  return digestHex('studyvis:presence:v1:', bytesToBase64(edPubkey))
}

export function presencePassword(edPubkey: Uint8Array): string {
  return digestHex('studyvis:presence-pw:v1:', bytesToBase64(edPubkey))
}
