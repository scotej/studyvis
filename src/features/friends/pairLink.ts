import { PAIR_WORD_COUNT } from './pair'
import { isBip39Word } from './wordlist'

// A compact, pasteable representation of a pairing code. This is NOT an
// OS-registered deep link — it's just a string the host copies (and the QR
// encodes) and the joiner pastes. The `c` value is the exact `words.join('-')`
// that derives the pairing topic, so encode → decode round-trips to the same
// code with no transcription. Treat it as the secret: same one-time, ~10-minute
// lifetime as the words; never log it.
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
