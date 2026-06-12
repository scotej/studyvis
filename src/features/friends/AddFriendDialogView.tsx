import { useCallback, useEffect, useRef, useState } from 'react'
import { CheckIcon, CopyIcon } from 'lucide-react'
import { toast } from 'sonner'

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
import { PairQrCode } from '@/components/PairQrCode'
import { PairQrScanner } from '@/components/PairQrScanner'
import { strings } from '@/strings'

import { PAIR_WORD_COUNT } from './pair'
import { decodePairLink, encodePairLink } from './pairLink'
import { PairWordInput } from './PairWordInput'
import {
  isBip39Word,
  pairCodeChecksumValid,
  pairWordsAreComplete,
  sanitizePairWordInput,
  tokenizePairWords,
} from './wordlist'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

export type AddFriendTab = 'host' | 'join'

export type AddFriendPhase =
  | { kind: 'idle' }
  | {
      kind: 'host-waiting'
      words: string[]
      peerArrived: boolean
      longWait?: boolean
      // F1 — set when the long wait elapsed AND no signaling relay is reachable
      // (read from the live socket map, not trystero's onJoinError, which never
      // fires on blocked relays). Blames the user's own network, not the friend.
      networkTrouble?: boolean
      // F5 — peer arrived but no direct link formed within the stall window;
      // also where a trystero handshake/decrypt error (onJoinError) lands.
      linkStalled?: boolean
    }
  | {
      kind: 'join-progress'
      peerArrived: boolean
      longWait?: boolean
      networkTrouble?: boolean
      linkStalled?: boolean
    }
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
  onCopyLink: (words: string[]) => Promise<boolean>
  // F10 — words to prefill into the Enter-code form (from an OS deep link).
  // Prefill only; never auto-submits.
  initialWords?: string[]
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
  onCopyLink,
  initialWords,
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
            onCopyLink={onCopyLink}
            initialWords={initialWords}
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
  onCopyLink,
  initialWords,
}: {
  tab: AddFriendTab
  onTabChange: (tab: AddFriendTab) => void
  phase: AddFriendPhase
  onStartHost: () => void
  onJoinSubmit: (words: string[]) => void
  onCancel: () => void
  onCopyLink: (words: string[]) => Promise<boolean>
  initialWords?: string[]
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
              onCopyLink={onCopyLink}
            />
          </TabsContent>
          <TabsContent value="join" className="mt-4">
            <JoinPanel
              key={`join-${(initialWords ?? []).join('-')}`}
              phase={phase}
              onSubmit={onJoinSubmit}
              onCancel={onCancel}
              initialWords={initialWords}
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
  onCopyLink,
}: {
  phase: AddFriendPhase
  onStart: () => void
  onCancel: () => void
  onCopyLink: (words: string[]) => Promise<boolean>
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

  if (phase.kind === 'host-waiting') {
    const words = phase.words
    const handleCopy = async () => {
      const ok = await onCopyLink(words)
      if (!ok) return
      setCopied(true)
      if (copiedTimer.current !== null) clearTimeout(copiedTimer.current)
      copiedTimer.current = setTimeout(() => setCopied(false), 1500)
    }
    return (
      <div className="flex flex-col gap-5">
        <div className="flex flex-col items-center gap-2">
          <PairQrCode value={encodePairLink(words)} label={host.qrAlt} />
          <p className="text-xs text-text-muted">{host.qrCaption}</p>
          <p className="text-center text-xs text-text-muted">
            {host.freshnessNote}
          </p>
        </div>
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
  if (phase.kind !== 'host-waiting') return null
  // F5 — peer arrived but no direct link formed: the most actionable failure.
  if (phase.linkStalled) {
    return (
      <p
        className="text-sm text-status-warning"
        aria-live="polite"
        role="alert"
      >
        {host.linkStalled}
      </p>
    )
  }
  if (phase.peerArrived) {
    return (
      <p className="text-sm text-text-secondary" aria-live="polite">
        {host.connected}
      </p>
    )
  }
  return (
    <div className="flex flex-col gap-1">
      <p className="text-sm text-text-secondary" aria-live="polite">
        {host.waiting}
      </p>
      {/* F1 — a network join error blames the user's own connection, not the
          friend; it takes precedence over the friend-blaming still-waiting hint. */}
      {phase.networkTrouble ? (
        <p className="text-xs text-status-warning" role="alert">
          {host.networkTrouble}
        </p>
      ) : phase.longWait ? (
        <p className="text-xs text-text-muted">{host.stillWaiting}</p>
      ) : null}
    </div>
  )
}

function emptyWords(): string[] {
  return Array.from({ length: PAIR_WORD_COUNT }, () => '')
}

function fillWords(source: string[] | undefined): string[] {
  return Array.from({ length: PAIR_WORD_COUNT }, (_, i) =>
    sanitizePairWordInput(source?.[i] ?? '')
  )
}

function JoinPanel({
  phase,
  onSubmit,
  onCancel,
  initialWords,
}: {
  phase: AddFriendPhase
  onSubmit: (words: string[]) => void
  onCancel: () => void
  initialWords?: string[]
}) {
  // F10 — initialized from the deep-link words (prefill ONLY: the user reviews
  // and presses Connect, so a page firing the scheme can never start a pairing
  // without an explicit click). `initialWords` is latched by AddFriendDialog on
  // the open transition and won't change while the dialog stays open, so the
  // `key` PairingStep derives from it is stable — a late re-delivery can't
  // remount this panel and discard a half-typed code. Seeded once at mount.
  const [words, setWords] = useState<string[]>(() => fillWords(initialWords))
  const allInWordlist = pairWordsAreComplete(words, PAIR_WORD_COUNT)
  // Connect is gated on the BIP39 checksum, not just per-word validity, so a
  // slip onto a different-but-valid word is caught here instead of silently
  // landing both devices in different rooms.
  const valid = allInWordlist && pairCodeChecksumValid(words)
  const inProgress = phase.kind === 'join-progress'
  const join = strings.friends.addDialog.join

  const handleClear = useCallback(() => {
    setWords(emptyWords())
  }, [])

  const handlePasteCode = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText()
      const decoded = decodePairLink(text) ?? tokenizePairWords(text)
      if (decoded.length === 0) throw new Error('nothing to paste')
      setWords(
        Array.from({ length: PAIR_WORD_COUNT }, (_, i) =>
          sanitizePairWordInput(decoded[i] ?? '')
        )
      )
    } catch {
      toast.error(join.pasteFailed)
    }
  }, [join.pasteFailed])

  const [scanning, setScanning] = useState(false)

  const handleScanDecode = useCallback(
    (text: string) => {
      setScanning(false)
      const decoded = decodePairLink(text)
      if (!decoded) {
        toast.error(join.scanNotRecognized)
        return
      }
      const filled = Array.from(
        { length: PAIR_WORD_COUNT },
        (_, i) => decoded[i] ?? ''
      )
      setWords(filled)
      // A real pairing QR always carries a valid checksum, so connect straight
      // away; on the off chance it doesn't, just fill and let the user submit.
      if (pairCodeChecksumValid(filled)) onSubmit(filled)
    },
    [join.scanNotRecognized, onSubmit]
  )

  const handleScanError = useCallback(() => {
    setScanning(false)
    toast.error(join.cameraFailed)
  }, [join.cameraFailed])

  if (inProgress) {
    return (
      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-1">
          {phase.linkStalled ? (
            <p
              className="text-sm text-status-warning"
              aria-live="polite"
              role="alert"
            >
              {join.linkStalled}
            </p>
          ) : (
            <>
              <p className="text-sm text-text-secondary" aria-live="polite">
                {phase.peerArrived ? join.connected : join.searching}
              </p>
              {/* F1 network-trouble hint outranks the still-searching one. */}
              {!phase.peerArrived && phase.networkTrouble ? (
                <p className="text-xs text-status-warning" role="alert">
                  {join.networkTrouble}
                </p>
              ) : !phase.peerArrived && phase.longWait ? (
                <p className="text-xs text-text-muted">{join.stillSearching}</p>
              ) : null}
            </>
          )}
        </div>
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

  if (scanning) {
    return (
      <div className="flex flex-col gap-4">
        <p className="text-sm text-text-secondary">{join.scanHint}</p>
        <PairQrScanner
          onDecode={handleScanDecode}
          onError={handleScanError}
          label={join.scanAria}
        />
        <DialogFooter>
          <Button variant="outline" onClick={() => setScanning(false)}>
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
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setScanning(true)}
          >
            {join.scanCta}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => void handlePasteCode()}
          >
            {join.pasteCta}
          </Button>
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
      </div>
      {allInWordlist && !valid ? (
        <p className="text-xs text-status-alerted" role="alert">
          {join.checksumHint}
        </p>
      ) : null}
      <ErrorBanner phase={phase} />
      <DialogFooter>
        <Button variant="outline" onClick={onCancel}>
          {strings.common.actions.cancel}
        </Button>
        <Button type="submit" disabled={!valid} aria-disabled={!valid}>
          {join.connectCta}
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
