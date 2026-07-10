import { useId, useLayoutEffect, useRef, useState } from 'react'
import { SendIcon } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { tokens } from '@/design/tokens'
import { strings } from '@/strings'

import { NOTE_MAX_LENGTH } from './notes'
import type { SessionNote } from './notesStore'

// #47 B6 — the quiet text strip under the session log: "brb 5", a link,
// without breaking the silence for everyone. Pure view — the store, wire
// send, and verification live in SessionView / notes.ts. Mirrors
// AuditLogPanel's SR semantics: role="log" list (implies polite live
// announcements) inside a labelled section.

export type SessionNotesPanelProps = {
  notes: ReadonlyArray<SessionNote>
  resolveName: (note: SessionNote) => string
  onSend: (text: string) => void
}

export function SessionNotesPanel({
  notes,
  resolveName,
  onSend,
}: SessionNotesPanelProps) {
  const headingId = useId()
  const copy = strings.session.notes
  const [draft, setDraft] = useState('')
  const scrollRef = useRef<HTMLDivElement | null>(null)

  // Keep the newest note in view (the list is short and session-scoped, so
  // unconditional pin-to-bottom is fine — unlike the audit log there's no
  // deep history to scroll back through mid-arrival).
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [notes.length])

  const submit = () => {
    const text = draft.trim()
    if (text.length === 0) return
    onSend(text)
    setDraft('')
  }

  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col border-l border-t border-border-subtle bg-bg-surface"
    >
      <header
        id={headingId}
        className="border-b border-border-subtle px-4 py-2 text-sm font-medium text-text-primary"
      >
        {copy.heading}
      </header>
      <div
        ref={scrollRef}
        className="overflow-y-auto"
        style={{ maxHeight: tokens.sizes.sessionNotesListMaxHeight }}
      >
        {notes.length === 0 ? (
          <p className="px-4 py-3 text-xs text-text-muted">{copy.empty}</p>
        ) : (
          <ul
            role="log"
            aria-live="polite"
            aria-relevant="additions"
            className="flex flex-col gap-1 px-4 py-2"
          >
            {notes.map((note) => (
              <li key={note.id} className="text-sm leading-snug">
                <span
                  className={
                    note.mine
                      ? 'font-medium text-text-secondary'
                      : 'font-medium text-accent-default'
                  }
                >
                  {resolveName(note)}
                </span>{' '}
                <span className="whitespace-pre-wrap break-words text-text-primary">
                  {note.text}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <form
        className="flex items-center gap-2 border-t border-border-subtle px-3 py-2"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={copy.placeholder}
          aria-label={copy.inputAriaLabel}
          maxLength={NOTE_MAX_LENGTH}
          className="h-8 text-sm"
        />
        <Button
          type="submit"
          variant="ghost"
          size="sm"
          disabled={draft.trim().length === 0}
          aria-label={copy.sendAriaLabel}
        >
          <SendIcon />
        </Button>
      </form>
    </section>
  )
}
