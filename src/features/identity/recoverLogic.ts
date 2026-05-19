import { MNEMONIC_WORD_COUNT, isValidMnemonic } from '@/lib/crypto/identity'

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
}

// Splits raw input into the three failure states the recovery screen shows
// (incomplete, wrong word count, bad checksum) plus the success case. Pure so
// the screen logic is node-testable without a DOM harness.
export function classifyMnemonic(raw: string): MnemonicClass {
  const words = normalizeMnemonicInput(raw)
  if (words.length === 0) return { kind: 'empty', words }
  if (words.length < MNEMONIC_WORD_COUNT) return { kind: 'short', words }
  if (words.length > MNEMONIC_WORD_COUNT) return { kind: 'long', words }
  return {
    kind: isValidMnemonic(words) ? 'valid' : 'invalid',
    words,
  }
}
