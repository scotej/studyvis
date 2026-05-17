import { useState } from 'react'
import { BookOpenIcon } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'

export type TopicGateModalProps = {
  open: boolean
  // Fired with the trimmed, non-empty topic. The caller writes it to
  // `setPendingInitialTopic` and then starts/joins the session, so the topic
  // is declared BEFORE any peer can see the session running.
  onSubmit: (topic: string) => void
  // Fired when the user backs out (Escape, overlay click, "Not now"). The
  // session must NOT start in this case.
  onCancel: () => void
}

// V2-P9 — the required "what are you working on?" gate. Shown only when AI is
// enabled, before `hostSession()`/`joinSession()` runs. Distinct from the
// mid-session Ctrl+] topic-change path (that mutates `declaredStudyTopic`;
// this seeds the one-shot `pendingInitialTopic`).
export function TopicGateModal({
  open,
  onSubmit,
  onCancel,
}: TopicGateModalProps) {
  const [value, setValue] = useState('')

  // Clear the field every time the gate (re)opens so a previous attempt's
  // text never leaks into the next session. This is the React-recommended
  // "adjust state during render on prop change" pattern (not an effect) —
  // see react.dev "You Might Not Need an Effect".
  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) setValue('')
  }

  const trimmed = value.trim()
  const canSubmit = trimmed.length > 0

  const submit = () => {
    if (!canSubmit) return
    onSubmit(trimmed)
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel()
      }}
    >
      <DialogContent
        aria-describedby="topic-gate-description"
        showCloseButton={false}
      >
        <DialogHeader>
          <div className="flex items-center gap-3">
            <span
              aria-hidden="true"
              className="flex size-9 items-center justify-center rounded-full bg-accent-default/15 text-accent-default"
            >
              <BookOpenIcon className="size-5" />
            </span>
            <DialogTitle>What are you working on?</DialogTitle>
          </div>
          <DialogDescription id="topic-gate-description">
            StudyVis shares this with the AI so it can tell when you drift
            off-topic. You can change it any time during the session with
            Cmd/Ctrl+].
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            submit()
          }}
        >
          <Input
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="e.g. Calculus problem set 4"
            aria-label="Study topic"
            maxLength={120}
          />
          <DialogFooter className="mt-4">
            <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
              Not now
            </Button>
            <Button
              type="submit"
              variant="default"
              size="sm"
              disabled={!canSubmit}
            >
              Start studying
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
