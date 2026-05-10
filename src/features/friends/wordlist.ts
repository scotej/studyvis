import { wordlist as englishWordlist } from '@scure/bip39/wordlists/english.js'

// Re-export the BIP39 English wordlist as a flat array (2048 entries) and as
// a Set for O(1) membership checks. Pair codes are drawn from this list, so
// the join input rejects anything that isn't on it — same approach Bitcoin
// recovery wallets use.
export const BIP39_WORDLIST = englishWordlist as readonly string[]

const BIP39_WORDS_SET: ReadonlySet<string> = new Set(BIP39_WORDLIST)

export function isBip39Word(word: string): boolean {
  return BIP39_WORDS_SET.has(word.toLowerCase())
}

// Strip every character that can't appear inside a BIP39 word, then lowercase.
// All BIP39 English words are 3–8 characters of [a-z].
export function sanitizePairWordInput(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z]/g, '')
    .slice(0, 8)
}

// Split free-form text (paste / typed line) into pair-code candidates by
// whitespace, lowercasing along the way. Empty tokens are dropped.
export function tokenizePairWords(raw: string): string[] {
  return raw
    .toLowerCase()
    .trim()
    .split(/\s+/)
    .map((w) => w.replace(/[^a-z]/g, ''))
    .filter((w) => w.length > 0)
}

// True iff every slot is in the BIP39 wordlist and the slot count matches.
// Used by the join form to enable the Connect button.
export function pairWordsAreComplete(
  words: string[],
  expectedCount: number
): boolean {
  if (words.length !== expectedCount) return false
  return words.every((w) => isBip39Word(w))
}
