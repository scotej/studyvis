// Model picker UI per ARCHITECTURE.md §8 / DESIGN-SYSTEM.md §4 inventory.
// Renders one card per registered model with download / benchmark
// affordances; opens the gated-token paste flow inline for the Gemma tier.
//
// All side-effects flow through injected `pickerActions` so unit tests and
// Storybook can drive the UI without Tauri (`__setDownloadRuntime` /
// `__setBenchmarkRuntime` mock the Rust side; the picker itself is pure
// presentation + a single async coordinator).

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  AlertCircleIcon,
  CheckIcon,
  CircleStopIcon,
  DownloadIcon,
  GaugeIcon,
  KeyIcon,
  RefreshCwIcon,
  Trash2Icon,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Progress } from '@/components/ui/progress'
import { Skeleton } from '@/components/ui/skeleton'
import { strings } from '@/strings'

import { isBenchmarkStale, type BenchmarkResult } from './benchmark'
import {
  type ModelSpec,
  SUPPORTED_MODELS,
  tierLabel,
  totalDownloadBytes,
} from './models'
import type { ModelRecord } from './modelStore'

export type DownloadPhase =
  | 'idle'
  | 'starting'
  | 'downloading-model'
  | 'downloading-mmproj'
  | 'verifying'
  | 'benchmark-starting'
  | 'benchmark-loading-image'
  | 'benchmark-running'
  | 'cancelling'
  | 'failed'

export type PickerStateForModel = {
  spec: ModelSpec
  installState: { modelExists: boolean; mmprojExists: boolean }
  record: ModelRecord | null
  // Active phase for this card, if any.
  phase: DownloadPhase
  // Current download progress (0..1) when a download is in flight; null
  // when in 'idle' / 'verifying' / benchmark phases (those use the spinner).
  downloadProgress: number | null
  // Sample ordinal during benchmark (1..N), undefined otherwise.
  benchmarkSampleIndex?: number
  benchmarkSampleTotal?: number
  // The latest error string for this card. Cleared on next user action.
  errorMessage: string | null
}

export type PickerActions = {
  // Triggered when the user clicks "Select" on an un-installed model.
  // Implementations should: HEAD-check both URLs, kick off the download,
  // verify SHA256s, run a benchmark, and persist the result.
  onSelect: (spec: ModelSpec) => void
  // Triggered when the user clicks "Re-benchmark" on an installed model.
  onRebenchmark: (spec: ModelSpec) => void
  // Triggered when the user clicks "Cancel" mid-download.
  onCancel: (spec: ModelSpec) => void
  // Triggered when the user clicks the trash button to remove an installed
  // (but not benchmarked or partially-installed) model.
  onRemove: (spec: ModelSpec) => void
  // Triggered when the user submits the HF token paste field.
  onSaveHfToken: (token: string) => void
  onClearHfToken: () => void
}

export type ModelPickerProps = {
  // Observation-only state. Derived in the parent so unit tests can pin
  // every state cleanly without juggling reducers in the picker itself.
  perModel: Record<string, PickerStateForModel>
  hfTokenPresent: boolean
  // Surfaces the "What model should I pick?" guide as a sibling render.
  guide: ReactNode
  actions: PickerActions
  // Settings is reachable during a live session (#47 B2), but the picker's
  // mutating actions share the sample loop's sidecar: stopping it for a
  // re-benchmark silently kills live focus detection (the loop has no
  // restart path and the AI chip keeps saying "active"), a benchmark run
  // concurrent with loop ticks contaminates the measured p95, and removing
  // a model deletes files a running llama-server holds open. Download /
  // Re-benchmark / Remove are disabled while a session is active.
  actionsLocked?: boolean
  className?: string
}

function formatBytesGB(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`
}

// A4 — compact human size for the "X downloaded" resume note. Sub-GB partials
// (interrupted early) read better in MB.
function formatBytesHuman(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  return `${Math.max(0, Math.round(bytes / 1024 ** 2))} MB`
}

function formatBenchmark(result: BenchmarkResult): string {
  return strings.ai.picker.speedSummary(result.p95Sec)
}

function phaseLabel(state: PickerStateForModel): string {
  const phases = strings.ai.picker.phases
  switch (state.phase) {
    case 'idle':
      return phases.idle
    case 'starting':
      return phases.starting
    case 'downloading-model':
      return phases.downloadingModel
    case 'downloading-mmproj':
      return phases.downloadingProjector
    case 'verifying':
      return phases.verifying
    case 'benchmark-starting':
      return phases.loading
    case 'benchmark-loading-image':
      return phases.preparingBenchmark
    case 'benchmark-running': {
      const i = state.benchmarkSampleIndex ?? 0
      const n = state.benchmarkSampleTotal ?? 0
      return n > 0 ? phases.runningSample(i, n) : phases.benchmarking
    }
    case 'cancelling':
      return phases.cancelling
    case 'failed':
      return state.errorMessage ?? phases.failedFallback
  }
}

function classifyPhase(p: DownloadPhase): {
  busy: boolean
  downloading: boolean
  cancelling: boolean
} {
  switch (p) {
    case 'idle':
    case 'failed':
      return { busy: false, downloading: false, cancelling: false }
    case 'cancelling':
      return { busy: true, downloading: false, cancelling: true }
    case 'downloading-model':
    case 'downloading-mmproj':
      return { busy: true, downloading: true, cancelling: false }
    case 'starting':
    case 'verifying':
    case 'benchmark-starting':
    case 'benchmark-loading-image':
    case 'benchmark-running':
      return { busy: true, downloading: false, cancelling: false }
  }
}

export function ModelPicker({
  perModel,
  hfTokenPresent,
  guide,
  actions,
  actionsLocked = false,
  className,
}: ModelPickerProps) {
  return (
    <div
      className={'flex flex-col gap-6' + (className ? ` ${className}` : '')}
      aria-label={strings.ai.picker.ariaLabel}
    >
      <header className="flex flex-col gap-1">
        {/* h3 at text-lg: the picker mounts mid-pane under the Settings → AI
            section h2, so its header is a sub-heading, not a rival section
            heading at the same visual weight. */}
        <h3 className="text-lg font-semibold tracking-tight text-text-primary">
          {strings.ai.picker.heading}
        </h3>
        <p className="text-sm text-text-secondary">{strings.ai.picker.body}</p>
        {actionsLocked ? (
          <p className="text-sm text-text-secondary">
            {strings.ai.picker.lockedDuringSession}
          </p>
        ) : null}
      </header>

      <div className="flex flex-col gap-4">
        {SUPPORTED_MODELS.map((spec) => {
          const state =
            perModel[spec.id] ??
            ({
              spec,
              installState: { modelExists: false, mmprojExists: false },
              record: null,
              phase: 'idle' as const,
              downloadProgress: null,
              errorMessage: null,
            } satisfies PickerStateForModel)
          return (
            <ModelCard
              key={spec.id}
              state={state}
              hfTokenPresent={hfTokenPresent}
              actions={actions}
              actionsLocked={actionsLocked}
            />
          )
        })}
      </div>

      {guide}
    </div>
  )
}

function ModelCard({
  state,
  hfTokenPresent,
  actions,
  actionsLocked,
}: {
  state: PickerStateForModel
  hfTokenPresent: boolean
  actions: PickerActions
  actionsLocked: boolean
}) {
  const { spec, installState, record, phase, errorMessage } = state
  const isInstalled = installState.modelExists && installState.mmprojExists
  const isPartial =
    !isInstalled && (installState.modelExists || installState.mmprojExists)
  // A4 — a known partial download (the Rust backend kept the `.tmp` and will
  // Range-resume it). Only honest when not already installed; don't fabricate
  // a Resume label without recorded partial state.
  const interrupted =
    !isInstalled && record?.interruptedDownload != null
      ? record.interruptedDownload
      : null
  const phaseClass = classifyPhase(phase)
  const busy = phaseClass.busy
  const showProgressBar =
    phaseClass.downloading && state.downloadProgress != null
  const benchmark = record?.benchmark ?? null
  const tokenPasteOpen = spec.gated && !hfTokenPresent && !busy && !isInstalled

  return (
    <article
      data-slot="model-card"
      data-tier={spec.defaultTier}
      data-installed={isInstalled || undefined}
      data-busy={busy || undefined}
      className="flex flex-col gap-4 rounded-lg border border-border-default bg-bg-surface p-5 shadow-sm"
      aria-labelledby={`model-${spec.id}-name`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex items-center gap-2">
            <span className="rounded-full bg-bg-raised px-2 py-0.5 text-xs font-medium uppercase tracking-wide text-text-secondary">
              {tierLabel(spec.defaultTier)}
            </span>
            {spec.gated ? (
              <span className="rounded-full bg-accent-muted px-2 py-0.5 text-xs font-medium uppercase tracking-wide text-text-inverse">
                {strings.ai.picker.pills.gated}
              </span>
            ) : null}
            {isInstalled ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-status-focused px-2 py-0.5 text-xs font-semibold uppercase tracking-wide text-text-inverse">
                <CheckIcon /> {strings.ai.picker.pills.installed}
              </span>
            ) : null}
            {isPartial ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-status-warning px-2 py-0.5 text-xs font-semibold uppercase tracking-wide text-text-inverse">
                <AlertCircleIcon /> {strings.ai.picker.pills.incomplete}
              </span>
            ) : null}
          </div>
          <h3
            id={`model-${spec.id}-name`}
            className="text-lg font-semibold tracking-tight text-text-primary"
          >
            {spec.displayName}
          </h3>
          <p className="text-sm text-text-secondary">{spec.blurb}</p>
        </div>
        <CardActions
          state={state}
          isInstalled={isInstalled}
          isPartial={isPartial}
          canResume={interrupted != null}
          hfTokenPresent={hfTokenPresent}
          actions={actions}
          actionsLocked={actionsLocked}
        />
      </div>

      <dl className="grid grid-cols-4 gap-x-6 gap-y-2 text-sm">
        <div className="flex flex-col">
          <dt className="text-xs uppercase tracking-wide text-text-muted">
            {strings.ai.picker.dataLabels.download}
          </dt>
          <dd className="text-text-primary">
            {formatBytesGB(totalDownloadBytes(spec))}
          </dd>
        </div>
        <div className="flex flex-col">
          <dt className="text-xs uppercase tracking-wide text-text-muted">
            {strings.ai.picker.dataLabels.ram}
          </dt>
          <dd className="text-text-primary">{spec.ramRequiredGB} GB</dd>
        </div>
        <div className="flex flex-col">
          <dt className="text-xs uppercase tracking-wide text-text-muted">
            {strings.ai.picker.dataLabels.license}
          </dt>
          <dd className="text-text-primary">{spec.license}</dd>
        </div>
        <div className="flex flex-col">
          <dt className="text-xs uppercase tracking-wide text-text-muted">
            {strings.ai.picker.dataLabels.quant}
          </dt>
          <dd className="font-mono text-text-primary">{spec.quantLabel}</dd>
        </div>
      </dl>

      {benchmark ? (
        isBenchmarkStale(benchmark) ? (
          // Measured on an older engine build/flags (e.g. pre-Metal-offload
          // CPU numbers on Apple Silicon): still shown, but not presented as
          // current — the Re-benchmark button above is the fix.
          <p className="flex items-start gap-2 text-sm text-text-secondary">
            <GaugeIcon className="mt-0.5 shrink-0" />
            <span>
              {formatBenchmark(benchmark)} {strings.ai.picker.staleBenchmark}
            </span>
          </p>
        ) : (
          <p className="flex items-center gap-2 text-sm text-status-focused">
            <GaugeIcon /> {formatBenchmark(benchmark)}
          </p>
        )
      ) : null}

      {interrupted && !busy ? (
        <p className="text-xs text-text-secondary">
          {strings.ai.picker.resumeNote(
            formatBytesHuman(interrupted.bytesReceived)
          )}
        </p>
      ) : null}

      {showProgressBar ? (
        <div className="flex flex-col gap-1">
          <Progress
            value={Math.round((state.downloadProgress ?? 0) * 100)}
            aria-label={`${spec.displayName} download progress`}
          />
          <p className="text-xs text-text-secondary">{phaseLabel(state)}</p>
        </div>
      ) : busy ? (
        <div className="flex flex-col gap-1">
          <Skeleton className="h-2 w-full" />
          <p className="text-xs text-text-secondary">{phaseLabel(state)}</p>
        </div>
      ) : null}

      {phase === 'failed' && errorMessage ? (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-md border border-status-alerted bg-bg-raised p-3 text-sm text-status-alerted"
        >
          <AlertCircleIcon className="mt-0.5 shrink-0" />
          <span className="min-w-0 break-words">{errorMessage}</span>
        </p>
      ) : null}

      {tokenPasteOpen ? (
        <HfTokenPaste
          repoSlug={spec.hfRepo}
          onSave={actions.onSaveHfToken}
          onClear={hfTokenPresent ? actions.onClearHfToken : undefined}
        />
      ) : null}
    </article>
  )
}

function CardActions({
  state,
  isInstalled,
  isPartial,
  canResume,
  hfTokenPresent,
  actions,
  actionsLocked,
}: {
  state: PickerStateForModel
  isInstalled: boolean
  isPartial: boolean
  // A4 — a partial download is known on disk; the primary action resumes it
  // (backend Range-resumes) rather than reading as a fresh download.
  canResume: boolean
  hfTokenPresent: boolean
  actions: PickerActions
  actionsLocked: boolean
}) {
  const { spec, phase } = state
  const phaseClass = classifyPhase(phase)
  // While in 'cancelling' we keep the Cancel button visible (just disabled);
  // every other busy state is "active work in progress."
  const downloadOrBenchmarkRunning = phaseClass.busy && !phaseClass.cancelling
  const blocksGated = spec.gated && !hfTokenPresent

  if (downloadOrBenchmarkRunning) {
    return (
      <Button
        variant="outline"
        size="sm"
        onClick={() => actions.onCancel(spec)}
        disabled={phaseClass.cancelling}
      >
        <CircleStopIcon /> {strings.ai.picker.cancelCta}
      </Button>
    )
  }

  if (isInstalled) {
    return (
      <div className="flex items-center gap-2">
        <Button
          variant="secondary"
          size="sm"
          onClick={() => actions.onRebenchmark(spec)}
          disabled={actionsLocked}
        >
          <RefreshCwIcon /> {strings.ai.picker.reBenchmarkCta}
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={strings.ai.picker.removeAriaLabel(spec.displayName)}
          onClick={() => actions.onRemove(spec)}
          disabled={actionsLocked}
        >
          <Trash2Icon />
        </Button>
      </div>
    )
  }

  if (isPartial) {
    return (
      <div className="flex items-center gap-2">
        <Button
          variant="default"
          size="sm"
          onClick={() => actions.onSelect(spec)}
          disabled={blocksGated || actionsLocked}
        >
          <DownloadIcon />{' '}
          {canResume
            ? strings.ai.picker.resumeCta
            : strings.ai.picker.reDownloadCta}
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={strings.ai.picker.removeAriaLabel(spec.displayName)}
          onClick={() => actions.onRemove(spec)}
          disabled={actionsLocked}
        >
          <Trash2Icon />
        </Button>
      </div>
    )
  }

  return (
    <Button
      variant="default"
      size="sm"
      onClick={() => actions.onSelect(spec)}
      disabled={blocksGated || actionsLocked}
      aria-disabled={blocksGated || actionsLocked || undefined}
    >
      <DownloadIcon />{' '}
      {canResume ? strings.ai.picker.resumeCta : strings.ai.picker.downloadCta}
    </Button>
  )
}

function HfTokenPaste({
  repoSlug,
  onSave,
  onClear,
}: {
  repoSlug: string
  onSave: (token: string) => void
  // V2-P9 wires the "Forget" affordance from Settings → AI; the form here
  // only renders for un-installed gated models, so this branch never fires
  // in V2-P2 — kept for symmetry / future extension.
  onClear?: () => void
}) {
  const [value, setValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  // Focus the field once it appears so the user can paste straight away.
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault()
      const trimmed = value.trim()
      if (trimmed.length > 0) {
        onSave(trimmed)
        setValue('')
      }
    },
    [onSave, value]
  )

  return (
    <form
      className="flex flex-col gap-2 rounded-md border border-border-subtle bg-bg-sunk p-3"
      onSubmit={handleSubmit}
    >
      <Label
        htmlFor="hf-token"
        className="flex items-center gap-2 text-xs uppercase tracking-wide text-text-secondary"
      >
        <KeyIcon /> {strings.ai.tokenPaste.heading}
      </Label>
      <p className="text-xs text-text-secondary">
        {strings.ai.tokenPaste.bodyBeforeRepo}
        <span className="font-mono">huggingface.co/{repoSlug}</span>
        {strings.ai.tokenPaste.bodyAfterRepo}
        <span className="font-mono">{strings.ai.tokenPaste.bodyTokensUrl}</span>
        {strings.ai.tokenPaste.bodyAfterTokensUrl}
      </p>
      <div className="flex items-center gap-2">
        <Input
          id="hf-token"
          ref={inputRef}
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={strings.ai.tokenPaste.placeholder}
          className="flex-1 font-mono"
        />
        <Button type="submit" variant="default" size="sm">
          {strings.ai.tokenPaste.saveCta}
        </Button>
        {onClear ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onClear}
            aria-label={strings.ai.tokenPaste.forgetAriaLabel}
          >
            {strings.ai.tokenPaste.forgetCta}
          </Button>
        ) : null}
      </div>
    </form>
  )
}
