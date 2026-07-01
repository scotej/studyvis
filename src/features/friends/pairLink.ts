import { base64UrlToBytes, bytesToBase64Url } from '@/lib/encoding'

import { parseContactCard } from './contactCard'
import { PAIR_WORD_COUNT } from './pair'
import { isBip39Word, tokenizePairWords } from './wordlist'

// A compact, pasteable representation of a pairing code. Since F10 the scheme
// is also OS-registered (`plugins.deep-link` in tauri.conf.json), so a clicked
// link reaches `pairDeepLink.ts` in addition to the copy/QR/paste paths. The
// `c` value is the exact `words.join('-')` that derives the pairing topic, so
// encode → decode round-trips to the same code with no transcription. Treat it
// as the secret: same one-time, ~10-minute lifetime as the words; never log it.
const PAIR_LINK_PREFIX = 'studyvis://pair?c='

export function encodePairLink(words: string[]): string {
  return `${PAIR_LINK_PREFIX}${words.join('-')}`
}

// Parse a pasted pairing link back into its words, or null if the text isn't a
// well-formed pair link (wrong scheme, missing/short/long code, or a token that
// isn't a BIP39 word). Tolerant of surrounding whitespace and case. Parsed by
// hand rather than via `new URL` so a custom scheme can't trip a platform's URL
// parser, and the hyphen separator is unambiguous (BIP39 words are [a-z] only).
export function decodePairLink(text: string): string[] | null {
  const trimmed = text.trim()
  if (!trimmed.toLowerCase().startsWith(PAIR_LINK_PREFIX)) return null
  const code = trimmed.slice(PAIR_LINK_PREFIX.length).split(/[&#\s]/)[0]
  const words = code
    .split('-')
    .map((w) => w.toLowerCase().replace(/[^a-z]/g, ''))
    .filter((w) => w.length > 0)
  if (words.length !== PAIR_WORD_COUNT) return null
  if (!words.every(isBip39Word)) return null
  return words
}

// A self-contained ContactCard link. Unlike the legacy word link, the payload
// after `#` is base64url and MUST be preserved byte-for-byte — base64url is
// case-sensitive, so (unlike decodePairLink) we never lowercase it. The `#`
// fragment keeps the card out of any query-string surface. Disjoint prefix from
// PAIR_LINK_PREFIX, so an old build's decodePairLink drops these cleanly.
export const CONTACT_LINK_PREFIX = 'studyvis://add#'

// Zero-width / soft-hyphen / word-joiner chars some chat clients inject into a
// pasted link. Stripped before extraction so they can't split the payload run.
const CONTACT_FORMAT_CHARS = /[\u200B-\u200D\u2060\uFEFF\u00AD]/g
// Case-insensitive on the scheme only; tolerates a trailing slash before `#`.
const CONTACT_PREFIX_RE = /studyvis:\/\/add\/?#/i

export function encodeContactLink(cardBytes: Uint8Array): string {
  return CONTACT_LINK_PREFIX + bytesToBase64Url(cardBytes)
}

// Recover ContactCard bytes from a pasted/scanned/OS-delivered link, tolerating
// surrounding chat text, wrappers, and glued punctuation: locate the prefix as a
// SUBSTRING (not startsWith), then take the maximal base64url run after it — any
// wrapper (`>`, `)`, `"`, `.`, whitespace) terminates the run. Returns null for
// a legacy `pair?c=` link or anything without a decodable card payload.
export function decodeContactLink(text: string): Uint8Array | null {
  const cleaned = text.replace(CONTACT_FORMAT_CHARS, '')
  const match = CONTACT_PREFIX_RE.exec(cleaned)
  if (!match) return null
  const after = cleaned.slice(match.index + match[0].length)
  const run = /^[A-Za-z0-9_-]+/.exec(after)
  if (!run) return null
  return base64UrlToBytes(run[0])
}

// Pure classifier for an OS-delivered deep-link URL: a contact card, a legacy
// pairing code, or neither. First non-null by exact prefix wins. Kept pure (no
// Tauri import) so it is unit-testable and shared by the deep-link subscriber.
export type DeepLinkRoute =
  | { kind: 'add'; card: Uint8Array }
  | { kind: 'pair'; words: string[] }
  | null

export function routeDeepLinkUrl(url: string): DeepLinkRoute {
  const card = decodeContactLink(url)
  // A structurally-valid card wins outright. A malformed card fragment does NOT
  // shadow a co-present valid legacy link — but a LONE bad card link still routes
  // to 'add' so the import sheet can explain why it's corrupt.
  if (card && parseContactCard(card).ok) return { kind: 'add', card }
  const words = decodePairLink(url)
  if (words) return { kind: 'pair', words }
  if (card) return { kind: 'add', card }
  return null
}

// Interpret arbitrary pasted/typed text from the "Add a friend" box. Accepts, in
// order: a full contact link, a legacy pairing link, a BARE base64url card (no
// prefix — parseContactCard is the real validator), or bare 12 BIP39 words.
// Returns null when nothing usable is present.
export type ImportInterpretation =
  | { kind: 'contact'; card: Uint8Array }
  | { kind: 'legacy'; words: string[] }
  | null

export function interpretImportText(text: string): ImportInterpretation {
  // A structurally-valid card link wins; a malformed card fragment must not
  // shadow a co-present valid legacy link (the lone-bad-card link still surfaces
  // below so its corrupt-card error is shown).
  const cardFromLink = decodeContactLink(text)
  if (cardFromLink && parseContactCard(cardFromLink).ok)
    return { kind: 'contact', card: cardFromLink }

  const legacyLink = decodePairLink(text)
  if (legacyLink) return { kind: 'legacy', words: legacyLink }

  if (cardFromLink) return { kind: 'contact', card: cardFromLink }

  // Bare base64url card pasted without the scheme prefix. Guard on a plausible
  // minimum length (a name-less card is ~174 chars) before trusting the parse.
  const raw = text.trim().replace(CONTACT_FORMAT_CHARS, '').replace(/\s+/g, '')
  if (/^[A-Za-z0-9_-]{170,}$/.test(raw)) {
    const bytes = base64UrlToBytes(raw)
    if (bytes && parseContactCard(bytes).ok)
      return { kind: 'contact', card: bytes }
  }

  const words = tokenizePairWords(text)
  if (words.length === PAIR_WORD_COUNT && words.every(isBip39Word)) {
    return { kind: 'legacy', words }
  }
  return null
}
