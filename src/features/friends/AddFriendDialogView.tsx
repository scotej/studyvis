// Pure presentational surface for the add-a-friend dialog: the default
// ContactCard mode (show my code as QR + copyable link, paste/scan theirs)
// and the legacy 12-word host/join tabs, with the F1/F5 connection-status
// hints. All pairing state arrives via the `AddFriendPhase` discriminated
// union from the AddFriendDialog container — no trystero, no stores here.

import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
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
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
// The QR encoder (qrcode) and scanner (jsqr) are moderate vendor deps used
// only inside this pairing dialog, never on a launch path. Lazy-load them so
// both land in a chunk fetched when the dialog opens, out of the cold-start
// bundle. PairQrCode already renders its own Skeleton while generating, so the
// Suspense fallbacks below match its shape and the two chain seamlessly.
const PairQrCode = lazy(() =>
  import('@/components/PairQrCode').then((m) => ({ default: m.PairQrCode }))
)
const PairQrScanner = lazy(() =>
  import('@/components/PairQrScanner').then((m) => ({
    default: m.PairQrScanner,
  }))
)
import { strings } from '@/strings'

import { PAIR_WORD_COUNT } from './pair'
import { decodePairLink, encodePairLink, interpretImportText } from './pairLink'
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
export type AddFriendMode = 'card' | 'legacy'
export type ImportSource = 'qr' | 'remote'

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
  // 'card' is the primary, offline ContactCard surface; 'legacy' is the retained
  // 12-word live-pairing flow for a friend who is still on an older build.
  mode: AddFriendMode
  onModeChange: (mode: AddFriendMode) => void
  missingDisplayName: boolean
  // Card surface. `myCardLink` is null while it is being built (needs a keyring
  // signature); `cardBuildError` marks a build failure.
  myCardLink: string | null
  cardBuildError: boolean
  onCopyCard: () => Promise<boolean>
  // Hands raw scanned/pasted/typed text up to the container, which routes it
  // (contact card → import confirm; legacy code → the word flow). `source`
  // decides whether the safety number is required downstream.
  onImportText: (text: string, source: ImportSource) => void
  // Legacy surface (unchanged 12-word live pairing).
  tab: AddFriendTab
  onTabChange: (tab: AddFriendTab) => void
  phase: AddFriendPhase
  onStartHost: () => void
  onJoinSubmit: (words: string[]) => void
  onCopyLink: (words: string[]) => Promise<boolean>
  // F10 — words to prefill into the legacy Enter-code form (from an OS deep
  // link). Prefill only; never auto-submits.
  initialWords?: string[]
  onCancel: () => void
}

export function AddFriendDialogView({
  open,
  onOpenChange,
  mode,
  onModeChange,
  missingDisplayName,
  myCardLink,
  cardBuildError,
  onCopyCard,
  onImportText,
  tab,
  onTabChange,
  phase,
  onStartHost,
  onJoinSubmit,
  onCopyLink,
  initialWords,
  onCancel,
}: AddFriendDialogViewProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        {missingDisplayName ? (
          <MissingDisplayNamePanel onCancel={onCancel} />
        ) : mode === 'legacy' ? (
          <LegacyStep
            tab={tab}
            onTabChange={onTabChange}
            phase={phase}
            onStartHost={onStartHost}
            onJoinSubmit={onJoinSubmit}
            onCancel={onCancel}
            onCopyLink={onCopyLink}
            initialWords={initialWords}
            onBack={() => onModeChange('card')}
          />
        ) : (
          <CardSurface
            myCardLink={myCardLink}
            cardBuildError={cardBuildError}
            onCopyCard={onCopyCard}
            onImportText={onImportText}
            onCancel={onCancel}
            onUseLegacy={() => onModeChange('legacy')}
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

function CardSurface({
  myCardLink,
  cardBuildError,
  onCopyCard,
  onImportText,
  onCancel,
  onUseLegacy,
}: {
  myCardLink: string | null
  cardBuildError: boolean
  onCopyCard: () => Promise<boolean>
  onImportText: (text: string, source: ImportSource) => void
  onCancel: () => void
  onUseLegacy: () => void
}) {
  const card = strings.friends.addDialog.card
  const [scanning, setScanning] = useState(false)
  const [copied, setCopied] = useState(false)
  const [pasteValue, setPasteValue] = useState('')
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      if (copiedTimer.current !== null) clearTimeout(copiedTimer.current)
    },
    []
  )

  const handleCopy = useCallback(async () => {
    const ok = await onCopyCard()
    if (!ok) return
    setCopied(true)
    if (copiedTimer.current !== null) clearTimeout(copiedTimer.current)
    copiedTimer.current = setTimeout(() => setCopied(false), 1500)
  }, [onCopyCard])

  const handlePasteClipboard = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText()
      if (!text.trim()) throw new Error('empty clipboard')
      onImportText(text, 'remote')
    } catch {
      toast.error(card.pasteFailed)
    }
  }, [card.pasteFailed, onImportText])

  const handleAddTyped = useCallback(() => {
    if (!pasteValue.trim()) return
    onImportText(pasteValue, 'remote')
  }, [pasteValue, onImportText])

  const handleScanDecode = useCallback(
    (text: string) => {
      setScanning(false)
      onImportText(text, 'qr')
    },
    [onImportText]
  )

  const handleScanError = useCallback(() => {
    setScanning(false)
    toast.error(card.cameraFailed)
  }, [card.cameraFailed])

  if (scanning) {
    return (
      <div className="flex flex-col gap-4">
        <DialogHeader>
          <DialogTitle>{card.addHeading}</DialogTitle>
          <DialogDescription>{card.scanHint}</DialogDescription>
        </DialogHeader>
        <Suspense
          fallback={<Skeleton className="aspect-square w-full rounded-lg" />}
        >
          <PairQrScanner
            onDecode={handleScanDecode}
            onError={handleScanError}
            label={card.scanAria}
            accept={(text) => interpretImportText(text) !== null}
          />
        </Suspense>
        <DialogFooter>
          <Button variant="outline" onClick={() => setScanning(false)}>
            {strings.common.actions.cancel}
          </Button>
        </DialogFooter>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-5">
      <DialogHeader>
        <DialogTitle>{card.title}</DialogTitle>
        <DialogDescription>{card.description}</DialogDescription>
      </DialogHeader>

      <section className="flex flex-col items-center gap-2">
        <h3 className="self-start text-sm font-medium text-text-primary">
          {card.yourCodeHeading}
        </h3>
        {cardBuildError ? (
          <p role="alert" className="text-sm text-status-alerted">
            {card.codeError}
          </p>
        ) : myCardLink ? (
          <>
            {/* Larger than the legacy word QR (224): the card is a denser
                ~200-char byte-mode payload, so more px-per-module keeps it
                scannable from a laptop camera across a desk. */}
            <Suspense
              fallback={<Skeleton className="aspect-square w-80 rounded-lg" />}
            >
              <PairQrCode value={myCardLink} label={card.qrAlt} size={320} />
            </Suspense>
            <p className="text-center text-xs text-text-muted">
              {card.qrCaption}
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void handleCopy()}
              aria-label={card.copyAriaLabel}
            >
              {copied ? (
                <>
                  <CheckIcon /> {card.copiedCta}
                </>
              ) : (
                <>
                  <CopyIcon /> {card.copyCta}
                </>
              )}
            </Button>
            <p className="text-center text-xs text-text-muted">
              {card.yourCodeCaption}
            </p>
          </>
        ) : (
          <div
            className="flex flex-col items-center gap-2"
            aria-busy="true"
            aria-label={card.codeBuilding}
          >
            <Skeleton className="aspect-square w-56 rounded-lg" />
            <p className="text-xs text-text-muted">{card.codeBuilding}</p>
          </div>
        )}
      </section>

      <Separator />

      <section className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h3 className="text-sm font-medium text-text-primary">
            {card.addHeading}
          </h3>
          <p className="text-xs text-text-muted">{card.addBody}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setScanning(true)}
          >
            {card.scanCta}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void handlePasteClipboard()}
          >
            {card.pasteCta}
          </Button>
        </div>
        <Textarea
          value={pasteValue}
          onChange={(e) => setPasteValue(e.target.value)}
          aria-label={card.inputAriaLabel}
          rows={2}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          className="font-mono text-xs"
        />
        <div className="flex justify-end">
          <Button
            type="button"
            size="sm"
            onClick={handleAddTyped}
            disabled={!pasteValue.trim()}
          >
            {card.addCta}
          </Button>
        </div>
      </section>

      <DialogFooter className="flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="justify-start text-text-secondary"
          onClick={onUseLegacy}
        >
          {card.legacyLink}
        </Button>
        <Button variant="outline" onClick={onCancel}>
          {strings.common.actions.cancel}
        </Button>
      </DialogFooter>
    </div>
  )
}

function LegacyStep({
  tab,
  onTabChange,
  phase,
  onStartHost,
  onJoinSubmit,
  onCancel,
  onCopyLink,
  initialWords,
  onBack,
}: {
  tab: AddFriendTab
  onTabChange: (tab: AddFriendTab) => void
  phase: AddFriendPhase
  onStartHost: () => void
  onJoinSubmit: (words: string[]) => void
  onCancel: () => void
  onCopyLink: (words: string[]) => Promise<boolean>
  initialWords?: string[]
  onBack: () => void
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
        <>
          <Tabs
            value={tab}
            onValueChange={(v) => onTabChange(v as AddFriendTab)}
          >
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
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="self-start text-text-secondary"
            onClick={onBack}
          >
            {strings.friends.addDialog.card.backToCards}
          </Button>
        </>
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
          <Suspense
            fallback={<Skeleton className="aspect-square w-56 rounded-lg" />}
          >
            <PairQrCode value={encodePairLink(words)} label={host.qrAlt} />
          </Suspense>
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
  // `key` LegacyStep derives from it is stable — a late re-delivery can't
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
        <Suspense
          fallback={<Skeleton className="aspect-square w-full rounded-lg" />}
        >
          <PairQrScanner
            onDecode={handleScanDecode}
            onError={handleScanError}
            label={join.scanAria}
          />
        </Suspense>
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
