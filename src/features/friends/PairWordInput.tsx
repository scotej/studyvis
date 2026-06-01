import {
  type ClipboardEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useId,
  useRef,
} from 'react'

import { cn } from '@/lib/utils'
import { strings } from '@/strings'

import { decodePairLink } from './pairLink'
import {
  BIP39_WORDLIST,
  isBip39Word,
  sanitizePairWordInput,
  tokenizePairWords,
} from './wordlist'

export type PairWordInputProps = {
  values: string[]
  onChange: (next: string[]) => void
  count: number
  disabled?: boolean
  autoFocus?: boolean
}

// 12-slot BIP39 word entry with autocomplete from the canonical wordlist.
// Mirrors the Bitcoin / Ethereum wallet recovery UX: typing a non-listed
// word marks the slot red, pasting a full code distributes across slots,
// and Space jumps to the next slot.
export function PairWordInput({
  values,
  onChange,
  count,
  disabled = false,
  autoFocus = false,
}: PairWordInputProps) {
  const datalistId = useId()
  const inputRefs = useRef<Array<HTMLInputElement | null>>([])

  useEffect(() => {
    if (autoFocus) inputRefs.current[0]?.focus()
  }, [autoFocus])

  const setSlot = useCallback(
    (index: number, value: string) => {
      const next = values.slice()
      while (next.length < count) next.push('')
      next[index] = value
      next.length = count
      onChange(next)
    },
    [values, count, onChange]
  )

  const distributeFrom = useCallback(
    (startIndex: number, words: string[]) => {
      const next = values.slice()
      while (next.length < count) next.push('')
      const room = count - startIndex
      // Pasted tokens go through the same sanitizer per-keystroke entry uses
      // (lowercase, strip non-letters, clamp to 8 chars) so paste and typing
      // agree on what each slot can hold.
      const slice = words.slice(0, room).map(sanitizePairWordInput)
      for (let i = 0; i < slice.length; i++) {
        next[startIndex + i] = slice[i]
      }
      next.length = count
      onChange(next)
      // Move focus to the slot after the last one we filled, clamped to last.
      const focusIndex = Math.min(startIndex + slice.length, count - 1)
      requestAnimationFrame(() => {
        inputRefs.current[focusIndex]?.focus()
        inputRefs.current[focusIndex]?.select()
      })
    },
    [values, count, onChange]
  )

  const handlePaste = useCallback(
    (index: number, e: ClipboardEvent<HTMLInputElement>) => {
      const text = e.clipboardData.getData('text')
      // A full pairing link fills every slot from the start, regardless of which
      // box received the paste.
      const fromLink = decodePairLink(text)
      if (fromLink) {
        e.preventDefault()
        distributeFrom(0, fromLink)
        return
      }
      const tokens = tokenizePairWords(text)
      if (tokens.length <= 1) return // single word paste — let default handler run
      e.preventDefault()
      distributeFrom(index, tokens)
    },
    [distributeFrom]
  )

  const handleKeyDown = useCallback(
    (index: number, e: KeyboardEvent<HTMLInputElement>) => {
      // Space → advance to next slot. We swallow the keystroke so the input
      // value never contains a literal space.
      if (e.key === ' ' || e.key === 'Spacebar') {
        e.preventDefault()
        const next = inputRefs.current[index + 1]
        if (next) {
          next.focus()
          next.select()
        }
        return
      }
      // Backspace on empty slot → jump back to previous slot and select it.
      if (
        e.key === 'Backspace' &&
        (e.currentTarget.value === '' || e.currentTarget.value === undefined)
      ) {
        const prev = inputRefs.current[index - 1]
        if (prev) {
          e.preventDefault()
          prev.focus()
          prev.select()
        }
      }
    },
    []
  )

  return (
    <>
      <ol
        aria-label={strings.friends.addDialog.join.ariaLabel}
        className="grid grid-cols-3 gap-x-3 gap-y-2"
      >
        {Array.from({ length: count }).map((_, index) => {
          const value = values[index] ?? ''
          const isValid = value === '' ? null : isBip39Word(value)
          const slotId = `${datalistId}-slot-${index}`
          const errorId = `${datalistId}-err-${index}`
          return (
            <li
              key={index}
              className={cn(
                'flex items-center gap-2 rounded-md border bg-bg-surface px-3 py-2 transition-colors focus-within:border-accent-default',
                isValid === false
                  ? 'border-status-alerted/60'
                  : isValid
                    ? 'border-status-focused/50'
                    : 'border-border-default'
              )}
            >
              <span
                aria-hidden
                className="w-5 shrink-0 text-right font-mono text-xs tabular-nums text-text-muted"
              >
                {String(index + 1).padStart(2, '0')}
              </span>
              <input
                id={slotId}
                ref={(el) => {
                  inputRefs.current[index] = el
                }}
                aria-label={strings.friends.addDialog.join.wordAriaLabel(
                  index + 1
                )}
                aria-invalid={isValid === false || undefined}
                aria-describedby={isValid === false ? errorId : undefined}
                list={datalistId}
                type="text"
                inputMode="text"
                autoComplete="off"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                disabled={disabled}
                value={value}
                onChange={(e) =>
                  setSlot(index, sanitizePairWordInput(e.target.value))
                }
                onKeyDown={(e) => handleKeyDown(index, e)}
                onPaste={(e) => handlePaste(index, e)}
                className={cn(
                  'min-w-0 flex-1 bg-transparent font-mono text-sm text-text-primary outline-none placeholder:text-text-muted disabled:cursor-not-allowed disabled:opacity-60',
                  isValid === false && 'text-status-alerted'
                )}
              />
              {isValid === false ? (
                <span id={errorId} className="sr-only">
                  {strings.friends.addDialog.join.notInWordlistSr}
                </span>
              ) : null}
            </li>
          )
        })}
      </ol>
      <datalist id={datalistId}>
        {BIP39_WORDLIST.map((w) => (
          <option key={w} value={w} />
        ))}
      </datalist>
    </>
  )
}
