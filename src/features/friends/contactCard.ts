import { verifyMessage } from '@/lib/crypto/identity'
import { bytesToHex, hexToBytes } from '@/lib/encoding'

// A ContactCard is a self-contained, self-signed friend code: it CARRIES the
// owner's public identity so importing it is a pure local parse + insert, with
// no relay rendezvous and no WebRTC on the pairing path. Binary layout (packed
// via base64url into `studyvis://add#…`, shown as a QR and a copyable code):
//
//   byte 0        version = 0x02
//   bytes 1..33   ed25519 pubkey (32B)  — canonical identity
//   bytes 33..65  x25519 pubkey  (32B)  — invite box-encryption target
//   byte 65       name_len (u8, 0..=NAME_CAP)
//   bytes 66..66+L display_name (UTF-8, L = name_len)
//   next 64 bytes ed25519 self-signature over bytes[0 .. 66+L]
//
// Total length is exactly 130 + name_len. The signature covers the version and
// name_len too, so a downgrade or any field tamper (notably an x-only swap that
// would redirect a friend's future encrypted invites) fails verification.
export const CARD_VERSION = 0x02
export const NAME_CAP = 32 // display_name hard limit, in UTF-8 bytes

const ED_LEN = 32
const X_LEN = 32
const SIG_LEN = 64
const HEADER_LEN = 1 + ED_LEN + X_LEN + 1 // version || ed || x || name_len = 66

export type ParsedContactCard = {
  version: number
  edPubkey: string // lowercase hex(32)
  xPubkey: string // lowercase hex(32)
  name: string
}

// Why a card was rejected, so the UI can pick honest copy:
//  - 'future-version' → a newer card format; tell the user to update StudyVis.
//  - 'corrupt'        → structurally invalid / undecodable / reserved version.
export type CardParseError = 'corrupt' | 'future-version'

export type ContactCardResult =
  | { ok: true; card: ParsedContactCard; isSelf: boolean }
  // 'tampered' = structure was fine but the self-signature didn't verify.
  | { ok: false; reason: CardParseError | 'tampered' }

function allZero(bytes: Uint8Array): boolean {
  for (let i = 0; i < bytes.length; i++) if (bytes[i] !== 0) return false
  return true
}

// Truncate a display name to <= maxBytes UTF-8 bytes WITHOUT splitting a code
// point (so a `fatal` UTF-8 decode on the far side can never fail). Prefers
// grapheme-cluster boundaries when Intl.Segmenter is available so an emoji ZWJ
// sequence isn't cut mid-cluster; falls back to code-point iteration otherwise.
function truncateUtf8(name: string, maxBytes: number): Uint8Array {
  const encoder = new TextEncoder()
  const full = encoder.encode(name)
  if (full.length <= maxBytes) return full
  const units =
    typeof Intl !== 'undefined' && 'Segmenter' in Intl
      ? Array.from(new Intl.Segmenter().segment(name), (s) => s.segment)
      : Array.from(name) // Array.from over a string iterates by code point.
  let out = ''
  let used = 0
  for (const unit of units) {
    const size = encoder.encode(unit).length
    if (used + size > maxBytes) break
    out += unit
    used += size
  }
  return encoder.encode(out)
}

// Build our own signed ContactCard bytes. `sign` is the keyring-bound ed25519
// signer (identity private keys never reach JS); we sign the exact byte range
// the far side re-derives for verification.
export async function buildContactCard(
  edPubHex: string,
  xPubHex: string,
  displayName: string,
  sign: (message: Uint8Array) => Promise<Uint8Array>
): Promise<Uint8Array> {
  const ed = hexToBytes(edPubHex)
  const x = hexToBytes(xPubHex)
  if (ed.length !== ED_LEN) throw new Error('ed pubkey must be 32 bytes')
  if (x.length !== X_LEN) throw new Error('x pubkey must be 32 bytes')
  const nameBytes = truncateUtf8(displayName ?? '', NAME_CAP)
  const signedLen = HEADER_LEN + nameBytes.length
  const signed = new Uint8Array(signedLen)
  signed[0] = CARD_VERSION
  signed.set(ed, 1)
  signed.set(x, 1 + ED_LEN)
  signed[65] = nameBytes.length
  signed.set(nameBytes, HEADER_LEN)
  const sig = await sign(signed)
  if (sig.length !== SIG_LEN) throw new Error('signature must be 64 bytes')
  const out = new Uint8Array(signedLen + SIG_LEN)
  out.set(signed, 0)
  out.set(sig, signedLen)
  return out
}

// Structural parse only — no signature check (see verifyContactCard). Reads the
// version FIRST so a future format is reported as such rather than as corrupt.
export function parseContactCard(
  bytes: Uint8Array
):
  | { ok: true; card: ParsedContactCard }
  | { ok: false; reason: CardParseError } {
  if (bytes.length < 1) return { ok: false, reason: 'corrupt' }
  const version = bytes[0]
  if (version >= 0x03) return { ok: false, reason: 'future-version' }
  if (version !== CARD_VERSION) return { ok: false, reason: 'corrupt' } // 0x00/0x01 reserved
  if (bytes.length < HEADER_LEN) return { ok: false, reason: 'corrupt' }
  const nameLen = bytes[65]
  if (nameLen > NAME_CAP) return { ok: false, reason: 'corrupt' }
  if (bytes.length !== HEADER_LEN + nameLen + SIG_LEN) {
    return { ok: false, reason: 'corrupt' }
  }
  const ed = bytes.slice(1, 1 + ED_LEN)
  const x = bytes.slice(1 + ED_LEN, 1 + ED_LEN + X_LEN)
  if (allZero(ed) || allZero(x)) return { ok: false, reason: 'corrupt' }
  const nameBytes = bytes.slice(HEADER_LEN, HEADER_LEN + nameLen)
  let name: string
  try {
    name = new TextDecoder('utf-8', { fatal: true }).decode(nameBytes)
  } catch {
    return { ok: false, reason: 'corrupt' }
  }
  return {
    ok: true,
    card: {
      version,
      edPubkey: bytesToHex(ed),
      xPubkey: bytesToHex(x),
      name,
    },
  }
}

// Verify the self-signature by reproducing the signed byte range from the raw
// buffer and checking it against the EMBEDDED ed key. Never re-serialize from
// parsed fields — the bytes on the wire are authoritative. Returns false on any
// structural problem too (verifyMessage swallows its own errors).
export function verifyContactCard(bytes: Uint8Array): boolean {
  if (bytes.length < HEADER_LEN + SIG_LEN) return false
  const nameLen = bytes[65]
  const signedLen = HEADER_LEN + nameLen
  if (bytes.length !== signedLen + SIG_LEN) return false
  const ed = bytes.slice(1, 1 + ED_LEN)
  const signed = bytes.slice(0, signedLen)
  const sig = bytes.slice(signedLen, signedLen + SIG_LEN)
  return verifyMessage(ed, signed, sig)
}

// Replicates verifyHello's self-pair guard (pair.ts): importing your own card
// would create a self friend row (the signature would verify), so reject it.
export function isSelfCard(cardEdHex: string, localEdHex: string): boolean {
  return cardEdHex.toLowerCase() === localEdHex.toLowerCase()
}

// One-shot: structural parse → signature verify → self check. Runs BEFORE any
// confirm UI so a hostile card never gets to show a (fake) safety number.
export function readContactCard(
  bytes: Uint8Array,
  localEdHex: string
): ContactCardResult {
  const parsed = parseContactCard(bytes)
  if (!parsed.ok) return { ok: false, reason: parsed.reason }
  if (!verifyContactCard(bytes)) return { ok: false, reason: 'tampered' }
  return {
    ok: true,
    card: parsed.card,
    isSelf: isSelfCard(parsed.card.edPubkey, localEdHex),
  }
}

// Render-time cleanup for a display name from an untrusted card: NFC-normalize
// and strip bidi-control and zero-width characters that could spoof how the name
// reads (embeddings/overrides U+202A-202E, isolates U+2066-2069, LRM/RLM
// U+200E/F, ZWSP/ZWNJ U+200B/C, word-joiner U+2060, soft-hyphen U+00AD, BOM
// U+FEFF). Deliberately KEEPS U+200D (ZWJ) so legitimate emoji sequences survive.
// The identity is the ed key, not the name — visual-confusion defense, not a reject.
export function sanitizeDisplayName(name: string): string {
  return name
    .normalize('NFC')
    .replace(
      /[\u200B\u200C\u200E\u200F\u202A-\u202E\u2060\u2066-\u2069\u00AD\uFEFF]/g,
      ''
    )
    .trim()
}
