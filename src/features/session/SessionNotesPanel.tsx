import { useId, useLayoutEffect, useRef, useState } from 'react'
import { ImagePlusIcon, SendIcon } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useReduceMotion } from '@/design/reduce-motion'
import { tokens } from '@/design/tokens'
import { strings } from '@/strings'

import { NOTE_MAX_LENGTH } from './notes'
import type { SessionImage, SessionNote } from './notesStore'

// #47 B6 — the quiet text strip under the session log: "brb 5", a link,
// without breaking the silence for everyone. Pure view — the store, wire
// send, and verification live in SessionView / notes.ts. Mirrors
// AuditLogPanel's SR semantics: role="log" list (implies polite live
// announcements) inside a labelled section.

export type SessionNotesPanelProps = {
  notes: ReadonlyArray<SessionNote>
  images: ReadonlyArray<SessionImage>
  resolveName: (item: SessionNote | SessionImage) => string
  onSend: (text: string) => void
  onSendImage: (file: File) => void
  onOpenImage: (image: SessionImage) => void
}

export function SessionNotesPanel({
  notes,
  images,
  resolveName,
  onSend,
  onSendImage,
  onOpenImage,
}: SessionNotesPanelProps) {
  const headingId = useId()
  const copy = strings.session.notes
  const imageCopy = strings.session.images
  const reduceMotion = useReduceMotion()
  const [draft, setDraft] = useState('')
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const entries = [...notes, ...images].sort((a, b) => a.ts - b.ts)
  const entriesKey = entries.map((entry) => `${entry.id}:${entry.ts}`).join('|')

  // Keep the newest note in view (the list is short and session-scoped, so
  // unconditional pin-to-bottom is fine — unlike the audit log there's no
  // deep history to scroll back through mid-arrival).
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [entriesKey])

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
      {/* Same tab stop as AuditLogPanel's scroller, and for the same reason:
          the note rows are plain text, the form below is a sibling, so a
          keyboard has nothing to focus inside the capped list. */}
      <div
        ref={scrollRef}
        tabIndex={0}
        className="overflow-y-auto outline-none focus-visible:ring-3 focus-visible:ring-inset focus-visible:ring-accent-ring"
        style={{ maxHeight: tokens.sizes.sessionNotesListMaxHeight }}
      >
        {entries.length === 0 ? (
          <p className="px-4 py-3 text-xs text-text-muted">{copy.empty}</p>
        ) : (
          <ul
            role="log"
            aria-live="polite"
            aria-relevant="additions"
            className="flex flex-col gap-1 px-4 py-2"
          >
            {entries.map((entry) => (
              <li key={entry.id} className="text-sm leading-snug">
                <span
                  className={
                    entry.mine
                      ? 'font-medium text-text-secondary'
                      : 'font-medium text-accent-default'
                  }
                >
                  {resolveName(entry)}
                </span>{' '}
                {'text' in entry ? (
                  <span className="whitespace-pre-wrap break-words text-text-primary">
                    {entry.text}
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => onOpenImage(entry)}
                    className="mt-1 block w-full overflow-hidden rounded-md border border-border-subtle bg-bg-sunk text-left outline-none focus-visible:ring-3 focus-visible:ring-accent-ring"
                    aria-label={imageCopy.openImage(resolveName(entry))}
                  >
                    {reduceMotion && entry.frameCount > 1 ? (
                      <span className="flex min-h-24 items-center justify-center px-3 text-center text-xs text-text-secondary">
                        {entry.filename}
                      </span>
                    ) : (
                      <img
                        src={entry.objectUrl}
                        alt={imageCopy.imageAlt(resolveName(entry))}
                        className="max-h-40 w-full object-contain"
                      />
                    )}
                    <span className="block truncate border-t border-border-subtle px-2 py-1 text-xs text-text-secondary">
                      {entry.filename}
                    </span>
                  </button>
                )}
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
        <input
          ref={fileInputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp,image/gif"
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
          onChange={(event) => {
            const file = event.target.files?.[0]
            event.target.value = ''
            if (file) onSendImage(file)
          }}
        />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => fileInputRef.current?.click()}
          aria-label={imageCopy.attachImage}
        >
          <ImagePlusIcon />
        </Button>
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
