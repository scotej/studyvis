// Single source of truth for byte/string encodings used on the wire.
// Standard base64 (no URL-safe variant), no padding manipulation. If a wire
// format ever needs URL-safe base64, add a separate helper rather than
// branching this one — silent variant drift is exactly the bug we are
// trying to avoid by centralizing.

export function bytesToHex(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i++)
    out += bytes[i].toString(16).padStart(2, '0')
  return out
}

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('hex must be even-length')
  // PR-34 — validate the WHOLE string up front. parseInt() silently accepts a
  // valid prefix and a leading sign/whitespace ('1g' → 0x01, '-a' → wraps,
  // ' a' → 0x0a), so a malformed-but-partially-valid hex pubkey would decode
  // to wrong-but-length-32 bytes instead of failing loud. In a key-custodial
  // wire format that must fail closed.
  if (!/^[0-9a-fA-F]*$/.test(hex)) throw new Error('invalid hex')
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return out
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

// URL-safe base64 (RFC 4648 §5), no padding. A SEPARATE helper from the
// standard pair above — the file header forbids branching those. Used only for
// the ContactCard payload embedded in `studyvis://add#…`, which travels through
// URLs, QR codes, and chat apps; `-`/`_` avoid `+`/`/` mangling and dropping
// `=` keeps the QR a touch smaller.
export function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

// STRICT decoder: returns null (never throws) on anything that isn't clean
// base64url. Rejects `+`, `/`, `=`, and any other stray char; only ASCII
// whitespace (which chat/QR round-trips can inject) is stripped first. We
// deliberately do NOT tolerate standard-base64 input — our encoder only ever
// emits base64url, so a `+`/`/` means the payload was corrupted in transit and
// failing loud beats a silent mis-decode into a wrong-but-valid card.
export function base64UrlToBytes(b64url: string): Uint8Array | null {
  const cleaned = b64url.replace(/\s+/g, '')
  if (cleaned.length === 0) return null
  if (!/^[A-Za-z0-9_-]+$/.test(cleaned)) return null
  // A base64 group is 4 chars → 3 bytes; a remainder of exactly 1 char is
  // never producible and marks a truncated payload.
  if (cleaned.length % 4 === 1) return null
  const b64 = cleaned.replace(/-/g, '+').replace(/_/g, '/')
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4)
  try {
    return base64ToBytes(padded)
  } catch {
    return null
  }
}
