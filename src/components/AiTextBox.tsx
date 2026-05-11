import { useEffect, useRef, type KeyboardEvent } from 'react'

import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

export type AiTextBoxProps = {
  value: string
  onChange: (next: string) => void
  // Fired when the user submits via Enter. The parent owns the actual
  // network call so the response bubble can render the AI's reply.
  onSubmit: () => void
  // Disable input + blank the placeholder while a request is in flight.
  pending?: boolean
  placeholder?: string
  className?: string
}

// V2-P7 — single-line input rendered inside the floating Ctrl+] dialog.
// Lives in `components/` (not `ui/`) because the styling decisions
// (placeholder copy, mono caret, focus ring) are app-specific to the AI
// dialog. The Esc-closes-window and Enter-submits semantics are owned
// by the dialog host, not this primitive: the dialog window listens for
// the OS-level keydown so the binding works even while focus is in this
// input. The component intentionally does NOT swallow Enter unless
// pending — that keeps the focus-trap simple.
export function AiTextBox({
  value,
  onChange,
  onSubmit,
  pending = false,
  placeholder = 'Ask the AI…',
  className,
}: AiTextBoxProps) {
  const ref = useRef<HTMLInputElement>(null)

  // Auto-focus on mount so the dialog is immediately typable. The window
  // creator sets focused=true at the OS level; this nudge ensures the
  // caret lands in the input even if the WebView decided to focus the
  // body element.
  useEffect(() => {
    ref.current?.focus()
  }, [])

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !pending && value.trim().length > 0) {
      e.preventDefault()
      onSubmit()
    }
  }

  return (
    <Input
      ref={ref}
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={handleKeyDown}
      disabled={pending}
      placeholder={pending ? 'Thinking…' : placeholder}
      aria-label="Ask the AI"
      autoComplete="off"
      autoCorrect="off"
      spellCheck={false}
      className={cn('font-sans text-sm', className)}
    />
  )
}
