import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertCircleIcon, CheckIcon, CopyIcon } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'
import { strings } from '@/strings'

import { PAIR_WORD_COUNT } from './pair'
import { PairWordInput } from './PairWordInput'
import { isBip39Word, pairWordsAreComplete } from './wordlist'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

export type AddFriendTab = 'host' | 'join'

export type AddFriendPhase =
  | { kind: 'idle' }
  | { kind: 'host-waiting'; words: string[]; peerArrived: boolean }
  | { kind: 'host-timeout'; words: string[] }
  | { kind: 'join-progress'; peerArrived: boolean }
  | { kind: 'join-timeout' }
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
  const copy = strings.friends.addDialog.missingName
  return (
    <div className="flex flex-col gap-5">
      <DialogHeader>
        <DialogTitle>{copy.title}</DialogTitle>
        <DialogDescription>{copy.body}</DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button variant="outline" onClick={onCancel}>
          {copy.cta}
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
  const pair = strings.friends.addDialog.pair
  return (
    <div className="flex flex-col gap-5">
      <DialogHeader>
        <DialogTitle>{pair.title}</DialogTitle>
        <DialogDescription>
          {pair.description(PAIR_WORD_COUNT)}
        </DialogDescription>
      </DialogHeader>

      {phase.kind === 'success' ? (
        <SuccessPanel name={phase.name} />
      ) : (
        <Tabs value={tab} onValueChange={(v) => onTabChange(v as AddFriendTab)}>
          <TabsList>
            <TabsTrigger value="host">{pair.tabs.generate}</TabsTrigger>
            <TabsTrigger value="join">{pair.tabs.enter}</TabsTrigger>
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
  const host = strings.friends.addDialog.host

  useEffect(
    () => () => {
      if (copiedTimer.current !== null) clearTimeout(copiedTimer.current)
    },
    []
  )

  if (phase.kind === 'host-waiting' || phase.kind === 'host-timeout') {
    const words = phase.words
    const handleCopy = async () => {
      const ok = await onCopyWords(words)
      if (!ok) return
      setCopied(true)
      if (copiedTimer.current !== null) clearTimeout(copiedTimer.current)
      copiedTimer.current = setTimeout(() => setCopied(false), 1500)
    }
    return (
      <div className="flex flex-col gap-5">
        <ol
          aria-label={host.codeAriaLabel}
          className="grid grid-cols-3 gap-x-6 gap-y-2 rounded-lg border border-border-default bg-bg-surface p-4 font-mono text-sm leading-snug"
        >
          {words.map((word, index) => (
            <li key={index} className="flex items-baseline gap-3 tabular-nums">
              <span className="w-6 text-right text-text-muted">
                {String(index + 1).padStart(2, '0')}
              </span>
              <span className="text-text-primary">{word}</span>
            </li>
          ))}
        </ol>
        <div className="flex items-center justify-between gap-3">
          <HostStatusLine phase={phase} />
          <Button
            variant="outline"
            size="sm"
            onClick={() => void handleCopy()}
            aria-label={host.copyAriaLabel}
          >
            {copied ? (
              <>
                <CheckIcon /> {host.copiedCta}
              </>
            ) : (
              <>
                <CopyIcon /> {host.copyCta}
              </>
            )}
          </Button>
        </div>
        <ErrorBanner phase={phase} />
        <DialogFooter>
          {phase.kind === 'host-timeout' ? (
            <Button onClick={onStart}>{host.tryNewCodeCta}</Button>
          ) : null}
          <Button variant="outline" onClick={onCancel}>
            {strings.common.actions.cancel}
          </Button>
        </DialogFooter>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-5">
      <p className="text-sm text-text-secondary">
        {host.introBody(PAIR_WORD_COUNT)}
      </p>
      <ErrorBanner phase={phase} />
      <DialogFooter>
        <Button onClick={onStart}>{host.generateCta}</Button>
      </DialogFooter>
    </div>
  )
}

function HostStatusLine({ phase }: { phase: AddFriendPhase }) {
  const host = strings.friends.addDialog.host
  if (phase.kind === 'host-timeout') {
    return (
      <p className="flex items-center gap-2 text-sm text-status-alerted">
        <AlertCircleIcon className="size-4" aria-hidden />
        {host.timeout}
      </p>
    )
  }
  if (phase.kind === 'host-waiting' && phase.peerArrived) {
    return (
      <p className="text-sm text-text-secondary" aria-live="polite">
        {host.connected}
      </p>
    )
  }
  return (
    <p className="text-sm text-text-secondary" aria-live="polite">
      {host.waiting}
    </p>
  )
}

function emptyWords(): string[] {
  return Array.from({ length: PAIR_WORD_COUNT }, () => '')
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
  const [words, setWords] = useState<string[]>(() => emptyWords())
  const valid = pairWordsAreComplete(words, PAIR_WORD_COUNT)
  const inProgress = phase.kind === 'join-progress'
  const isTimeout = phase.kind === 'join-timeout'
  const join = strings.friends.addDialog.join

  const handleClear = useCallback(() => {
    setWords(emptyWords())
  }, [])

  if (inProgress) {
    return (
      <div className="flex flex-col gap-5">
        <p className="text-sm text-text-secondary" aria-live="polite">
          {phase.peerArrived ? join.connected : join.searching}
        </p>
        <div
          aria-hidden="true"
          className="flex flex-col gap-2 rounded-lg border border-border-default bg-bg-surface p-4"
        >
          <Skeleton className="h-3 w-2/3" />
          <Skeleton className="h-3 w-1/2" />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            {strings.common.actions.cancel}
          </Button>
        </DialogFooter>
      </div>
    )
  }

  const filledCount = words.filter((w) => w.length > 0).length
  const validCount = words.filter((w) => w.length > 0 && isBip39Word(w)).length

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault()
        if (!valid) return
        onSubmit(words)
      }}
    >
      <p className="text-xs text-text-muted">{join.hint(PAIR_WORD_COUNT)}</p>
      <PairWordInput
        values={words}
        onChange={setWords}
        count={PAIR_WORD_COUNT}
        autoFocus
        disabled={inProgress}
      />
      <div className="flex items-center justify-between gap-3">
        <p
          className={
            valid
              ? 'text-xs text-status-focused'
              : filledCount > 0 && filledCount === validCount
                ? 'text-xs text-text-secondary'
                : 'text-xs text-text-muted'
          }
        >
          {join.validCount(validCount, PAIR_WORD_COUNT)}
          {filledCount > 0 && filledCount > validCount
            ? ` · ${join.notInWordlist(filledCount - validCount)}`
            : ''}
        </p>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={handleClear}
          disabled={filledCount === 0}
        >
          {join.clearCta}
        </Button>
      </div>
      {isTimeout ? (
        <p
          role="alert"
          className="rounded-md border border-status-alerted/40 bg-status-alerted/10 px-3 py-2 text-sm text-status-alerted"
        >
          <AlertCircleIcon
            className="mr-1 inline size-4 -translate-y-px"
            aria-hidden
          />
          {join.timeout}
        </p>
      ) : null}
      <ErrorBanner phase={phase} />
      <DialogFooter>
        <Button variant="outline" onClick={onCancel}>
          {strings.common.actions.cancel}
        </Button>
        <Button type="submit" disabled={!valid} aria-disabled={!valid}>
          {isTimeout ? join.tryAgainCta : join.connectCta}
        </Button>
      </DialogFooter>
    </form>
  )
}

function SuccessPanel({ name }: { name: string }) {
  const success = strings.friends.addDialog.success
  return (
    <div
      role="status"
      className="flex flex-col items-center gap-3 rounded-lg border border-status-focused/40 bg-status-focused/10 px-6 py-8 text-center"
    >
      <CheckIcon className="size-6 text-status-focused" aria-hidden />
      <p className="text-base font-medium text-text-primary">
        {success.title(name)}
      </p>
      <p className="text-sm text-text-secondary">{success.body}</p>
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
