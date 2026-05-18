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
  Loader2Icon,
  RefreshCwIcon,
  Trash2Icon,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Progress } from '@/components/ui/progress'

import { type BenchmarkResult } from './benchmark'
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
  className?: string
}

function formatBytesGB(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`
}

function formatBenchmark(result: BenchmarkResult): string {
  return `Speed on your machine: ${result.p95Sec.toFixed(1)} seconds per check`
}

function phaseLabel(state: PickerStateForModel): string {
  switch (state.phase) {
    case 'idle':
      return ''
    case 'starting':
      return 'Starting…'
    case 'downloading-model':
      return 'Downloading model…'
    case 'downloading-mmproj':
      return 'Downloading projector…'
    case 'verifying':
      return 'Verifying SHA-256…'
    case 'benchmark-starting':
      return 'Loading model into memory…'
    case 'benchmark-loading-image':
      return 'Preparing benchmark image…'
    case 'benchmark-running': {
      const i = state.benchmarkSampleIndex ?? 0
      const n = state.benchmarkSampleTotal ?? 0
      return n > 0 ? `Running sample ${i} / ${n}…` : 'Benchmarking…'
    }
    case 'cancelling':
      return 'Cancelling…'
    case 'failed':
      return state.errorMessage ?? 'Something went wrong.'
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
  className,
}: ModelPickerProps) {
  return (
    <div
      className={'flex flex-col gap-6' + (className ? ` ${className}` : '')}
      aria-label="Vision model picker"
    >
      <header className="flex flex-col gap-1">
        <h2 className="text-xl font-semibold tracking-tight text-text-primary">
          Pick a vision model
        </h2>
        <p className="text-sm text-text-secondary">
          The model runs on your own machine and judges only your camera and
          screen. Smaller is faster; bigger is more thorough.
        </p>
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
}: {
  state: PickerStateForModel
  hfTokenPresent: boolean
  actions: PickerActions
}) {
  const { spec, installState, record, phase, errorMessage } = state
  const isInstalled = installState.modelExists && installState.mmprojExists
  const isPartial =
    !isInstalled && (installState.modelExists || installState.mmprojExists)
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
                Gated
              </span>
            ) : null}
            {isInstalled ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-status-focused px-2 py-0.5 text-xs font-semibold uppercase tracking-wide text-text-inverse">
                <CheckIcon /> Installed
              </span>
            ) : null}
            {isPartial ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-status-warning px-2 py-0.5 text-xs font-semibold uppercase tracking-wide text-text-inverse">
                <AlertCircleIcon /> Incomplete
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
          hfTokenPresent={hfTokenPresent}
          actions={actions}
        />
      </div>

      <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
        <div className="flex flex-col">
          <dt className="text-xs uppercase tracking-wide text-text-muted">
            Download
          </dt>
          <dd className="text-text-primary">
            {formatBytesGB(totalDownloadBytes(spec))}
          </dd>
        </div>
        <div className="flex flex-col">
          <dt className="text-xs uppercase tracking-wide text-text-muted">
            RAM
          </dt>
          <dd className="text-text-primary">{spec.ramRequiredGB} GB</dd>
        </div>
        <div className="flex flex-col">
          <dt className="text-xs uppercase tracking-wide text-text-muted">
            License
          </dt>
          <dd className="text-text-primary">{spec.license}</dd>
        </div>
        <div className="flex flex-col">
          <dt className="text-xs uppercase tracking-wide text-text-muted">
            Quant
          </dt>
          <dd className="font-mono text-text-primary">{spec.quantLabel}</dd>
        </div>
      </dl>

      {benchmark ? (
        <p className="flex items-center gap-2 text-sm text-status-focused">
          <GaugeIcon /> {formatBenchmark(benchmark)}
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
        <p className="flex items-center gap-2 text-xs text-text-secondary">
          <Loader2Icon className="animate-spin" /> {phaseLabel(state)}
        </p>
      ) : null}

      {phase === 'failed' && errorMessage ? (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-md border border-status-alerted bg-bg-raised p-3 text-sm text-status-alerted"
        >
          <AlertCircleIcon className="mt-0.5 shrink-0" />
          <span>{errorMessage}</span>
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
  hfTokenPresent,
  actions,
}: {
  state: PickerStateForModel
  isInstalled: boolean
  isPartial: boolean
  hfTokenPresent: boolean
  actions: PickerActions
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
        <CircleStopIcon /> Cancel
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
        >
          <RefreshCwIcon /> Re-benchmark
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Remove ${spec.displayName}`}
          onClick={() => actions.onRemove(spec)}
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
          disabled={blocksGated}
        >
          <DownloadIcon /> Re-download
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Remove ${spec.displayName}`}
          onClick={() => actions.onRemove(spec)}
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
      disabled={blocksGated}
      aria-disabled={blocksGated || undefined}
    >
      <DownloadIcon /> Download
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
        <KeyIcon /> Paste your Hugging Face access token
      </Label>
      <p className="text-xs text-text-secondary">
        This model is gated. Accept the terms at{' '}
        <span className="font-mono">huggingface.co/{repoSlug}</span> first, then
        paste a read-scope token from{' '}
        <span className="font-mono">huggingface.co/settings/tokens</span>. Your
        token is stored in the OS keychain, never sent anywhere.
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
          placeholder="hf_xxxxxxxxxxxxxxxxxxxxxxxxx"
          className="flex-1 font-mono"
        />
        <Button type="submit" variant="default" size="sm">
          Save
        </Button>
        {onClear ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onClear}
            aria-label="Forget saved Hugging Face token"
          >
            Forget
          </Button>
        ) : null}
      </div>
    </form>
  )
}
