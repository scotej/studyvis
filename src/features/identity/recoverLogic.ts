import { wordlist as englishWordlist } from '@scure/bip39/wordlists/english.js'

import {
  MNEMONIC_WORD_COUNT,
  isValidMnemonic,
  mnemonicFingerprint,
} from '@/lib/crypto/identity'

// O(1) membership set over the 2048 English BIP39 words. Imported here rather
// than from features/friends' isBip39Word: friends already imports
// @/features/identity, so the reverse edge would form a feature cycle.
const ENGLISH_WORDS: ReadonlySet<string> = new Set(englishWordlist)

// The subset of already-normalized tokens that aren't real BIP39 words. Splits
// the coarse "invalid" failure into its actionable half: a misread word the
// user can hunt for, versus a checksum-only slip (returns []).
function unknownBip39Words(words: string[]): string[] {
  return words.filter((w) => !ENGLISH_WORDS.has(w))
}

// Someone retyping 24 words from paper will use newlines, double spaces, and
// stray capitals. @scure/bip39 splits on a single ASCII space and matches the
// wordlist case-sensitively, so we normalize here before it ever sees the
// phrase: NFKD, lowercase, collapse every run of whitespace, drop empties.
export function normalizeMnemonicInput(raw: string): string[] {
  return raw.normalize('NFKD').toLowerCase().split(/\s+/u).filter(Boolean)
}

export type MnemonicClassKind = 'empty' | 'short' | 'long' | 'invalid' | 'valid'

export type MnemonicClass = {
  kind: MnemonicClassKind
  words: string[]
  // Only populated on the 24-word 'invalid' path (the words not in the BIP39
  // wordlist); '[]' for every other kind, including a checksum-only 'invalid'.
  unknownWords: string[]
}

// Splits raw input into the three failure states the recovery screen shows
// (incomplete, wrong word count, bad checksum) plus the success case. Pure so
// the screen logic is node-testable without a DOM harness.
export function classifyMnemonic(raw: string): MnemonicClass {
  const words = normalizeMnemonicInput(raw)
  if (words.length === 0) return { kind: 'empty', words, unknownWords: [] }
  if (words.length < MNEMONIC_WORD_COUNT)
    return { kind: 'short', words, unknownWords: [] }
  if (words.length > MNEMONIC_WORD_COUNT)
    return { kind: 'long', words, unknownWords: [] }
  const valid = isValidMnemonic(words)
  return {
    kind: valid ? 'valid' : 'invalid',
    words,
    unknownWords: valid ? [] : unknownBip39Words(words),
  }
}

// D5 — what the recover flow should do once a valid 24-word phrase is entered:
//   - 'commit'      : no identity on this device, OR the typed words recompute
//                     to the SAME fingerprint already stored. Restoring the
//                     same keys over themselves is a harmless no-op, so we skip
//                     the warning entirely.
//   - 'confirm'     : an identity exists but its stored fingerprint is unknown
//                     (legacy record). Fall back to the generic overwrite
//                     confirm rather than risk a silent clobber.
//   - 'confirm-different' : the typed words are a DIFFERENT identity; replacing
//                     is destructive and friends will need the new key — show
//                     the escalated warning.
//
// Pure so the decision is node-testable without the keychain or a DOM harness.
export type OverwriteDecision = 'commit' | 'confirm' | 'confirm-different'

export function decideOverwrite(
  words: string[],
  identityExists: boolean,
  currentFingerprint: string | null | undefined
): OverwriteDecision {
  if (!identityExists) return 'commit'
  if (!currentFingerprint) return 'confirm'
  return mnemonicFingerprint(words) === currentFingerprint
    ? 'commit'
    : 'confirm-different'
}
