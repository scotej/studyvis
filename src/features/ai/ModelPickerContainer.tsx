// Container for `ModelPicker` that owns:
//  * subscribing to `model:progress` events from Rust
//  * downloading and selecting models independently from benchmarking
//  * driving sidecar_stop + benchmark for "Benchmark" / "Re-benchmark"
//  * persisting benchmark results to `useModelStore`
//  * keychain-token round-trips
//
// The presenter (`ModelPicker.tsx`) stays pure; this file is the only
// place that touches Tauri command runtimes.

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react'
import { toast } from 'sonner'

import { ModelGuide } from './ModelGuide'
import {
  ModelPicker,
  type DownloadPhase,
  type ModelPickerProps,
  type PickerStateForModel,
} from './ModelPicker'
import {
  downloadFraction,
  emptyPickerState,
  progressEventToPhase,
} from './picker-helpers'
import { runBenchmark, type BenchmarkProgress } from './benchmark'
import { ERR_ENGINE_NOT_INSTALLED, useSidecarStore } from './sidecar'
import {
  getDownloadRuntime,
  specToFileRequests,
  type ProgressEvent,
} from './download'
import { getHfTokenRuntime } from './hfToken'
import { SUPPORTED_MODELS, type ModelSpec } from './models'
import { useModelStore } from './modelStore'
import { useSessionStore } from '@/stores/sessionStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { strings } from '@/strings'

type CardState = PickerStateForModel

type CardUpdate = Partial<Omit<CardState, 'spec'>>

export type ModelPickerContainerProps = {
  onBusyChange?: (busy: boolean) => void
}

export type ModelPickerContainerHandle = {
  benchmarkSelected: () => boolean
}

export const ModelPickerContainer = forwardRef<
  ModelPickerContainerHandle,
  ModelPickerContainerProps
>(function ModelPickerContainer({ onBusyChange }, ref) {
  const records = useModelStore((s) => s.records)
  const activeModelId = useModelStore((s) => s.activeModelId)
  const hydrate = useModelStore((s) => s.hydrate)
  const recordInstalled = useModelStore((s) => s.recordInstalled)
  const selectModel = useModelStore((s) => s.selectModel)
  const recordBenchmark = useModelStore((s) => s.recordBenchmark)
  const recordInterruptedDownload = useModelStore(
    (s) => s.recordInterruptedDownload
  )
  const forget = useModelStore((s) => s.forget)
  const status = useModelStore((s) => s.status)
  // Settings is reachable mid-session (#47 B2). Model setup is safe while AI
  // is off, but locks once the live loop owns the shared sidecar.
  const sessionActive = useSessionStore((s) => s.status === 'active')
  const aiFeaturesEnabled = useSettingsStore((s) => s.values.aiFeaturesEnabled)
  const actionsLocked = sessionActive && aiFeaturesEnabled

  const [cards, setCards] = useState<Record<string, CardState>>(() =>
    emptyPickerState()
  )
  const [hfTokenPresent, setHfTokenPresent] = useState(false)
  const [hfTokenChecked, setHfTokenChecked] = useState(false)

  const setupBusy = Object.values(cards).some(
    (card) => card.phase !== 'idle' && card.phase !== 'failed'
  )

  useEffect(() => {
    onBusyChange?.(setupBusy)
  }, [onBusyChange, setupBusy])

  useEffect(
    () => () => {
      onBusyChange?.(false)
    },
    [onBusyChange]
  )

  // A4 — the latest `bytes_received` seen on a 'downloading' event per model.
  // The Rust terminal failed/cancelled events hardcode bytes_received: 0 (they
  // report the all-files summary, not the in-flight byte count), so we stash
  // the running value from the streaming events and use it when the download
  // ends abnormally. This is the same offset the Rust side Range-resumes from
  // (the running count includes any prior resume offset), so the "X
  // downloaded" resume label stays honest.
  const lastDownloadBytes = useRef<Record<string, number>>({})

  const updateCard = useCallback((modelId: string, patch: CardUpdate) => {
    setCards((prev) => {
      const existing =
        prev[modelId] ??
        ({
          ...emptyPickerState()[modelId],
        } satisfies CardState)
      return { ...prev, [modelId]: { ...existing, ...patch } }
    })
  }, [])

  // Notify the settings gate in the originating click before async work can
  // yield. The derived setupBusy effect keeps it accurate after that first
  // transition, including when several cards have work in flight.
  const startCardWork = useCallback(
    (modelId: string, patch: CardUpdate) => {
      onBusyChange?.(true)
      updateCard(modelId, patch)
    },
    [onBusyChange, updateCard]
  )

  // Hydrate persistent records once on mount.
  //
  // I83 — retry on `'error'` too, not only `'loading'`. A LazyStore read of
  // models.json can fail transiently (an AV scanner holding the file, a
  // partial write from a previous run), and `status: 'error'` used to be
  // terminal for the whole process: `activeModelId` stayed null, so no AI ran
  // for any session until the app was restarted, and this — the one surface
  // that could re-read it — refused to try. `hydrate()` early-returns only on
  // `'ready'`, and this effect's deps re-run it on a status CHANGE rather than
  // in a loop, so a persistent failure costs one attempt per visit here.
  useEffect(() => {
    if (status !== 'ready') void hydrate()
  }, [status, hydrate])

  // Probe initial install state for every model so the cards reflect what's
  // already on disk. Runs once after mount.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const runtime = getDownloadRuntime()
      for (const spec of SUPPORTED_MODELS) {
        try {
          const state = await runtime.installState(spec.id)
          if (cancelled) return
          updateCard(spec.id, {
            installState: {
              modelExists: state.model.exists,
              mmprojExists: state.mmproj.exists,
            },
          })
        } catch {
          // command may not be wired yet (Storybook / unit env); ignore
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [updateCard])

  // Probe HF-token presence once. The keychain commands aren't wired on
  // Linux (Linux is V3+); a thrown invoke is treated as "no token".
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const present = await getHfTokenRuntime().present()
        if (!cancelled) setHfTokenPresent(present)
      } catch {
        if (!cancelled) setHfTokenPresent(false)
      } finally {
        if (!cancelled) setHfTokenChecked(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // A4 — record an interruption from the last streaming byte count we saw for
  // this model. No-op when we never observed any bytes (the picker keeps the
  // plain "Download"/"Re-download" CTA rather than fabricating a resume label).
  const recordPartialFromLastSeen = useCallback(
    (modelId: string) => {
      const bytes = lastDownloadBytes.current[modelId]
      if (typeof bytes === 'number' && bytes > 0) {
        void recordInterruptedDownload(modelId, bytes)
      }
    },
    [recordInterruptedDownload]
  )

  const handleProgress = useCallback(
    (evt: ProgressEvent) => {
      const next = progressEventToPhase(evt)
      if (next) {
        // A4 — only the streaming 'downloading' events carry a real byte
        // count; stash the running value so a later terminal failed/cancelled
        // event (which reports 0) can record an honest resume offset.
        if (evt.phase === 'downloading' && evt.bytes_received > 0) {
          lastDownloadBytes.current[evt.model_id] = evt.bytes_received
        }
        const fraction = downloadFraction(evt)
        updateCard(evt.model_id, {
          phase: next,
          downloadProgress: fraction,
          errorMessage: null,
        })
        return
      }
      if (evt.phase === 'failed') {
        updateCard(evt.model_id, {
          phase: 'failed',
          downloadProgress: null,
          errorMessage: evt.error ?? 'Download failed.',
        })
        // A4 — the backend keeps the `.tmp` on a stream/write error, so the
        // next download Range-resumes. The terminal event itself carries
        // bytes_received: 0 (it's the all-files summary), so use the running
        // count stashed from the last 'downloading' event. Record the partial
        // so the picker reads as "Resume download".
        recordPartialFromLastSeen(evt.model_id)
        return
      }
      if (evt.phase === 'cancelled') {
        updateCard(evt.model_id, {
          phase: 'idle',
          downloadProgress: null,
          errorMessage: null,
        })
        // A4 — cancel also keeps the `.tmp` (Rust comment), so a cancelled
        // download is resumable too. Same byte-count caveat as 'failed'.
        recordPartialFromLastSeen(evt.model_id)
        return
      }
      if (evt.phase === 'done' && evt.file === 'all') {
        // The whole download finished (the terminal all-files summary); any
        // stale partial marker is cleared by recordInstalled. Drop the running
        // byte count so a future download of the same model starts its resume
        // accounting clean. Per-file 'done' events (file === 'model'/'mmproj')
        // are NOT terminal — the next file's 'downloading' events will refresh
        // the running count — so we leave the stash alone for those.
        delete lastDownloadBytes.current[evt.model_id]
      }
      // 'done' is otherwise handled by the in-flight download coordinator,
      // which records the install and returns the card to idle.
    },
    [updateCard, recordPartialFromLastSeen]
  )

  // Subscribe to download progress events. Cleanup on unmount.
  useEffect(() => {
    let unlisten: (() => void) | null = null
    let cancelled = false
    void (async () => {
      try {
        const fn = await getDownloadRuntime().subscribeProgress(handleProgress)
        if (cancelled) {
          fn()
          return
        }
        unlisten = fn
      } catch {
        // Storybook / unit harness without Tauri events: silently skip.
      }
    })()
    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [handleProgress])

  const refreshInstallState = useCallback(
    async (spec: ModelSpec) => {
      try {
        const state = await getDownloadRuntime().installState(spec.id)
        updateCard(spec.id, {
          installState: {
            modelExists: state.model.exists,
            mmprojExists: state.mmproj.exists,
          },
        })
      } catch {
        // ignore — idle state is a safe fallback
      }
    },
    [updateCard]
  )

  const runBenchmarkFor = useCallback(
    async (spec: ModelSpec) => {
      // Never let the benchmark process coexist with enabled AI. Even outside
      // a session, one could start while the multi-minute benchmark owns the
      // singleton sidecar. Benchmarking during an AI-off session is safe and
      // is the intended "Benchmark first" path.
      if (useSettingsStore.getState().values.aiFeaturesEnabled) {
        updateCard(spec.id, {
          phase: 'idle',
          downloadProgress: null,
          errorMessage: null,
        })
        toast.info(strings.ai.picker.benchmarkWhileAiEnabled)
        return
      }
      const runtime = getDownloadRuntime()
      startCardWork(spec.id, {
        phase: 'benchmark-starting',
        downloadProgress: null,
        errorMessage: null,
      })
      try {
        const paths = await runtime.paths(spec.id)
        // V2-P1 carryover: stop any in-flight sidecar before launching the
        // benchmark so re-benchmark doesn't trip the "child already running"
        // re-entry rejection.
        await useSidecarStore.getState().stop()
        const result = await runBenchmark(spec, {
          modelPath: paths.model_path,
          mmprojPath: paths.mmproj_path,
          onProgress: (p: BenchmarkProgress) => {
            const phase = benchmarkPhaseToCard(p)
            updateCard(spec.id, {
              phase,
              benchmarkSampleIndex: p.phase === 'sample' ? p.index : undefined,
              benchmarkSampleTotal: p.phase === 'sample' ? p.total : undefined,
            })
          },
        })
        await recordBenchmark(spec.id, result)
        updateCard(spec.id, {
          phase: 'idle',
          downloadProgress: null,
          benchmarkSampleIndex: undefined,
          benchmarkSampleTotal: undefined,
          errorMessage: null,
        })
        toast.success(
          strings.ai.picker.readyToast(spec.displayName, result.p95Sec)
        )
      } catch (err) {
        const raw = err instanceof Error ? err.message : String(err)
        // I73 — the bare engine_not_installed sentinel would otherwise land
        // on the card verbatim; the engine row above is the fix, name it.
        const message =
          raw === ERR_ENGINE_NOT_INSTALLED
            ? strings.ai.picker.engineMissing
            : raw
        updateCard(spec.id, {
          phase: 'failed',
          downloadProgress: null,
          errorMessage: message,
        })
      }
    },
    [updateCard, startCardWork, recordBenchmark]
  )

  const runDownload = useCallback(
    async (spec: ModelSpec) => {
      const runtime = getDownloadRuntime()
      startCardWork(spec.id, {
        phase: 'starting',
        downloadProgress: 0,
        errorMessage: null,
      })

      // 1) HEAD-check both URLs to fail fast on size mismatch / auth errors
      // before committing to the full download.
      const files = specToFileRequests(spec)
      try {
        for (const file of files) {
          const head = await runtime.headCheck(file.url, spec.gated)
          if (head.status === 401 || head.status === 403) {
            throw new Error(
              spec.gated
                ? strings.ai.picker.hfRejectedDetailed(head.status, spec.hfRepo)
                : strings.ai.picker.hfRejected(head.status)
            )
          }
          if (head.status >= 400) {
            throw new Error(strings.ai.picker.headBadUrl(file.url, head.status))
          }
          if (
            head.content_length != null &&
            head.content_length !== file.size_bytes
          ) {
            throw new Error(
              strings.ai.picker.sizeMismatch(
                head.content_length,
                file.kind,
                file.size_bytes
              )
            )
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        updateCard(spec.id, {
          phase: 'failed',
          downloadProgress: null,
          errorMessage: message,
        })
        return
      }

      // 2) Kick off the actual download. Progress events flip phase via the
      // listener installed in useEffect above.
      try {
        await runtime.startDownload(spec.id, files, spec.gated)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        if (message === 'cancelled') {
          updateCard(spec.id, {
            phase: 'idle',
            downloadProgress: null,
            errorMessage: null,
          })
        } else {
          updateCard(spec.id, {
            phase: 'failed',
            downloadProgress: null,
            errorMessage: message,
          })
        }
        await refreshInstallState(spec)
        return
      }

      await refreshInstallState(spec)
      await recordInstalled(spec.id)

      // First install becomes the selected model, but never switch models as
      // an in-flight download finishes while AI is enabled. That would bypass
      // the unbenchmarked enable warning. A later model stays installed until
      // the user explicitly clicks "Use model."
      let selected = false
      const modelState = useModelStore.getState()
      const aiEnabled = useSettingsStore.getState().values.aiFeaturesEnabled
      if (!modelState.activeModelId && !aiEnabled) {
        await selectModel(spec.id)
        selected = true
      }

      updateCard(spec.id, {
        phase: 'idle',
        downloadProgress: null,
        errorMessage: null,
      })
      toast.success(
        selected
          ? strings.ai.picker.installedAndSelectedToast(spec.displayName)
          : strings.ai.picker.installedToast(spec.displayName)
      )
    },
    [
      updateCard,
      startCardWork,
      refreshInstallState,
      recordInstalled,
      selectModel,
    ]
  )

  const onDownload = useCallback(
    (spec: ModelSpec) => {
      void runDownload(spec)
    },
    [runDownload]
  )

  const onBenchmark = useCallback(
    (spec: ModelSpec) => {
      void runBenchmarkFor(spec)
    },
    [runBenchmarkFor]
  )

  useImperativeHandle(
    ref,
    () => ({
      benchmarkSelected: () => {
        const selectedId = useModelStore.getState().activeModelId
        const selected = SUPPORTED_MODELS.find((spec) => spec.id === selectedId)
        if (!selected) return false
        onBenchmark(selected)
        return true
      },
    }),
    [onBenchmark]
  )

  const onActivate = useCallback(
    (spec: ModelSpec) => {
      void (async () => {
        const sessionOwnsSidecar =
          useSessionStore.getState().status === 'active' &&
          useSettingsStore.getState().values.aiFeaturesEnabled
        if (sessionOwnsSidecar) {
          toast.info(strings.ai.picker.modelChangesWhileAiRunning)
          return
        }

        try {
          const existingRecord = useModelStore.getState().records[spec.id]
          if (!existingRecord || existingRecord.installedAt == null) {
            await recordInstalled(spec.id)
          }
          const benchmark =
            useModelStore.getState().records[spec.id]?.benchmark ?? null
          const settings = useSettingsStore.getState()
          if (settings.values.aiFeaturesEnabled && !benchmark) {
            toast.info(strings.ai.picker.selectUnbenchmarkedTurnAiOff)
            return
          }
          await selectModel(spec.id)
          toast.success(strings.ai.picker.selectedToast(spec.displayName))
        } catch (err) {
          toast.error(
            strings.ai.picker.selectErrorToast(
              spec.displayName,
              err instanceof Error ? err.message : String(err)
            )
          )
        }
      })()
    },
    [recordInstalled, selectModel]
  )

  const onCancel = useCallback(
    (spec: ModelSpec) => {
      updateCard(spec.id, { phase: 'cancelling' })
      void getDownloadRuntime()
        .cancelDownload(spec.id)
        .catch((err) => {
          const message = err instanceof Error ? err.message : String(err)
          updateCard(spec.id, {
            phase: 'failed',
            errorMessage: message,
          })
        })
    },
    [updateCard]
  )

  const onRemove = useCallback(
    (spec: ModelSpec) => {
      void (async () => {
        if (
          useModelStore.getState().activeModelId === spec.id &&
          useSettingsStore.getState().values.aiFeaturesEnabled
        ) {
          toast.info(strings.ai.picker.removeActiveTurnAiOff)
          return
        }
        startCardWork(spec.id, {
          phase: 'removing',
          downloadProgress: null,
          errorMessage: null,
        })
        try {
          await getDownloadRuntime().remove(spec.id)
          await forget(spec.id)
          await refreshInstallState(spec)
          updateCard(spec.id, {
            phase: 'idle',
            downloadProgress: null,
            errorMessage: null,
          })
          toast.success(strings.ai.picker.removedToast(spec.displayName))
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          updateCard(spec.id, {
            phase: 'failed',
            downloadProgress: null,
            errorMessage: message,
          })
          toast.error(
            strings.ai.picker.removeErrorToast(spec.displayName, message)
          )
        }
      })()
    },
    [forget, refreshInstallState, startCardWork, updateCard]
  )

  const onSaveHfToken = useCallback((token: string) => {
    void (async () => {
      try {
        await getHfTokenRuntime().save(token)
        setHfTokenPresent(true)
        toast.success(strings.settings.ai.hfToken.savedToast)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        toast.error(`${strings.settings.ai.hfToken.saveErrorPrefix}${message}`)
      }
    })()
  }, [])

  const onClearHfToken = useCallback(() => {
    void (async () => {
      try {
        await getHfTokenRuntime().clear()
        setHfTokenPresent(false)
        toast.success(strings.settings.ai.hfToken.removedToast)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        toast.error(
          `${strings.settings.ai.hfToken.removeErrorPrefix}${message}`
        )
      }
    })()
  }, [])

  // Reproject `cards` with the latest record from useModelStore.
  const perModel: Record<string, PickerStateForModel> = Object.fromEntries(
    SUPPORTED_MODELS.map((spec) => {
      const card = cards[spec.id] ?? emptyPickerState()[spec.id]
      return [
        spec.id,
        {
          ...card,
          record: records[spec.id] ?? null,
        },
      ]
    })
  )

  const props: ModelPickerProps = {
    perModel,
    activeModelId,
    hfTokenPresent: hfTokenChecked ? hfTokenPresent : false,
    guide: <ModelGuide records={records} />,
    actions: {
      onDownload,
      onActivate,
      onBenchmark,
      onCancel,
      onRemove,
      onSaveHfToken,
      onClearHfToken,
    },
    actionsLocked,
  }

  return <ModelPicker {...props} />
})

function benchmarkPhaseToCard(p: BenchmarkProgress): DownloadPhase {
  switch (p.phase) {
    case 'starting-sidecar':
      return 'benchmark-starting'
    case 'loading-image':
      return 'benchmark-loading-image'
    case 'warmup':
    case 'sample':
      return 'benchmark-running'
    case 'done':
      return 'idle'
  }
}
