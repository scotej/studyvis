import { useEffect, useRef, useState } from 'react'
import { CheckIcon, CopyIcon, Loader2Icon } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'

import { PAIR_WORD_COUNT } from './pair'

export type AddFriendTab = 'host' | 'join'

export type AddFriendPhase =
  | { kind: 'idle' }
  | { kind: 'host-waiting'; words: string[] }
  | { kind: 'join-progress' }
  | { kind: 'success'; name: string }
  | { kind: 'error'; message: string }

export type AddFriendDialogViewProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  tab: AddFriendTab
  onTabChange: (tab: AddFriendTab) => void
  phase: AddFriendPhase
  missingDisplayName: boolean
  onStartHost: () => void
  onJoinSubmit: (words: string[]) => void
  onCancel: () => void
  onCopyWords: (words: string[]) => Promise<boolean>
}

function normalizeWords(input: string): string[] {
  return input
    .toLowerCase()
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0)
}

export function AddFriendDialogView({
  open,
  onOpenChange,
  tab,
  onTabChange,
  phase,
  missingDisplayName,
  onStartHost,
  onJoinSubmit,
  onCancel,
  onCopyWords,
}: AddFriendDialogViewProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        {missingDisplayName ? (
          <MissingDisplayNamePanel onCancel={onCancel} />
        ) : (
          <PairingStep
            tab={tab}
            onTabChange={onTabChange}
            phase={phase}
            onStartHost={onStartHost}
            onJoinSubmit={onJoinSubmit}
            onCancel={onCancel}
            onCopyWords={onCopyWords}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function MissingDisplayNamePanel({ onCancel }: { onCancel: () => void }) {
  return (
    <div className="flex flex-col gap-5">
      <DialogHeader>
        <DialogTitle>Finish onboarding first</DialogTitle>
        <DialogDescription>
          Pick a display name in onboarding before adding friends — it&apos;s
          how they&apos;ll see you when you pair.
        </DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button variant="outline" onClick={onCancel}>
          Got it
        </Button>
      </DialogFooter>
    </div>
  )
}

function PairingStep({
  tab,
  onTabChange,
  phase,
  onStartHost,
  onJoinSubmit,
  onCancel,
  onCopyWords,
}: {
  tab: AddFriendTab
  onTabChange: (tab: AddFriendTab) => void
  phase: AddFriendPhase
  onStartHost: () => void
  onJoinSubmit: (words: string[]) => void
  onCancel: () => void
  onCopyWords: (words: string[]) => Promise<boolean>
}) {
  return (
    <div className="flex flex-col gap-5">
      <DialogHeader>
        <DialogTitle>Add a friend</DialogTitle>
        <DialogDescription>
          Share a one-time {PAIR_WORD_COUNT}-word code over any chat. The code
          is good for one pairing and then discarded.
        </DialogDescription>
      </DialogHeader>

      {phase.kind === 'success' ? (
        <SuccessPanel name={phase.name} />
      ) : (
        <Tabs value={tab} onValueChange={(v) => onTabChange(v as AddFriendTab)}>
          <TabsList>
            <TabsTrigger value="host">Generate code</TabsTrigger>
            <TabsTrigger value="join">Enter code</TabsTrigger>
          </TabsList>
          <TabsContent value="host" className="mt-4">
            <HostPanel
              phase={phase}
              onStart={onStartHost}
              onCancel={onCancel}
              onCopyWords={onCopyWords}
            />
          </TabsContent>
          <TabsContent value="join" className="mt-4">
            <JoinPanel
              phase={phase}
              onSubmit={onJoinSubmit}
              onCancel={onCancel}
            />
          </TabsContent>
        </Tabs>
      )}
    </div>
  )
}

function HostPanel({
  phase,
  onStart,
  onCancel,
  onCopyWords,
}: {
  phase: AddFriendPhase
  onStart: () => void
  onCancel: () => void
  onCopyWords: (words: string[]) => Promise<boolean>
}) {
  const [copied, setCopied] = useState(false)
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      if (copiedTimer.current !== null) clearTimeout(copiedTimer.current)
    },
    []
  )

  if (phase.kind === 'host-waiting') {
    const handleCopy = async () => {
      const ok = await onCopyWords(phase.words)
      if (!ok) return
      setCopied(true)
      if (copiedTimer.current !== null) clearTimeout(copiedTimer.current)
      copiedTimer.current = setTimeout(() => setCopied(false), 1500)
    }
    return (
      <div className="flex flex-col gap-5">
        <ol
          aria-label="One-time pairing code"
          className="grid grid-cols-3 gap-x-6 gap-y-2 rounded-lg border border-border-default bg-bg-surface p-4 font-mono text-sm leading-snug"
        >
          {phase.words.map((word, index) => (
            <li key={index} className="flex items-baseline gap-3 tabular-nums">
              <span className="w-6 text-right text-text-muted">
                {String(index + 1).padStart(2, '0')}
              </span>
              <span className="text-text-primary">{word}</span>
            </li>
          ))}
        </ol>
        <div className="flex items-center justify-between gap-3">
          <p className="flex items-center gap-2 text-sm text-text-secondary">
            <Loader2Icon className="size-4 animate-spin" aria-hidden />
            Waiting for your friend to enter the code…
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void handleCopy()}
            aria-label="Copy code to clipboard"
          >
            {copied ? (
              <>
                <CheckIcon /> Copied
              </>
            ) : (
              <>
                <CopyIcon /> Copy
              </>
            )}
          </Button>
        </div>
        <ErrorBanner phase={phase} />
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
        </DialogFooter>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-5">
      <p className="text-sm text-text-secondary">
        We'll generate {PAIR_WORD_COUNT} words. Send them to your friend over
        any messenger; they enter them on the other tab.
      </p>
      <ErrorBanner phase={phase} />
      <DialogFooter>
        <Button onClick={onStart}>Generate code</Button>
      </DialogFooter>
    </div>
  )
}

function JoinPanel({
  phase,
  onSubmit,
  onCancel,
}: {
  phase: AddFriendPhase
  onSubmit: (words: string[]) => void
  onCancel: () => void
}) {
  const [text, setText] = useState('')
  const words = normalizeWords(text)
  const valid = words.length === PAIR_WORD_COUNT
  const inProgress = phase.kind === 'join-progress'

  if (inProgress) {
    return (
      <div className="flex flex-col gap-5">
        <p className="flex items-center gap-2 text-sm text-text-secondary">
          <Loader2Icon className="size-4 animate-spin" aria-hidden />
          Connecting to your friend…
        </p>
        <ErrorBanner phase={phase} />
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
        </DialogFooter>
      </div>
    )
  }

  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={(e) => {
        e.preventDefault()
        if (!valid) return
        onSubmit(words)
      }}
    >
      <div className="flex flex-col gap-2">
        <Label htmlFor="pair-words">Paste the {PAIR_WORD_COUNT} words</Label>
        <Textarea
          id="pair-words"
          autoFocus
          rows={3}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          className="font-mono"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <p className="text-xs text-text-muted">
          {words.length} / {PAIR_WORD_COUNT} words
        </p>
      </div>
      <ErrorBanner phase={phase} />
      <DialogFooter>
        <Button type="submit" disabled={!valid} aria-disabled={!valid}>
          Connect
        </Button>
      </DialogFooter>
    </form>
  )
}

function SuccessPanel({ name }: { name: string }) {
  return (
    <div
      role="status"
      className="flex flex-col items-center gap-3 rounded-lg border border-status-focused/40 bg-status-focused/10 px-6 py-8 text-center"
    >
      <CheckIcon className="size-6 text-status-focused" aria-hidden />
      <p className="text-base font-medium text-text-primary">
        Paired with {name}.
      </p>
      <p className="text-sm text-text-secondary">
        They're now in your friends list.
      </p>
    </div>
  )
}

function ErrorBanner({ phase }: { phase: AddFriendPhase }) {
  if (phase.kind !== 'error') return null
  return (
    <p
      role="alert"
      className="rounded-md border border-status-alerted/40 bg-status-alerted/10 px-3 py-2 text-sm text-status-alerted"
    >
      {phase.message}
    </p>
  )
}
