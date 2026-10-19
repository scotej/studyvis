// Persistent state for installed models + benchmark results. Mirrors the
// `useSettingsStore` pattern (LazyStore-backed, deps-injected for tests),
// but lives in its own `models.json` file so the settings store's
// type-narrow setters and DEFAULTS aren't polluted by per-model records.

import { LazyStore } from '@tauri-apps/plugin-store'
import { create } from 'zustand'

import type { BenchmarkResult } from './benchmark'
import { getDownloadRuntime } from './download'
import { getModelUnavailableReason } from './models'
import { logger } from '@/lib/log'
import { strings } from '@/strings'

const log = logger.child('ai.models')

// A4 — recorded when a download errors/interrupts partway so the picker can
// honestly read as "Resume download" rather than restart-from-zero. The Rust
// backend keeps the `.tmp` across runs and auto-resumes with an HTTP Range
// request on the next `model_download`, so the offset here is informational
// (the resume itself is byte-exact on the Rust side). Cleared once the model
// finishes installing or is removed.
export type InterruptedDownload = {
  // Bytes the last download had received when it errored (from the final
  // model:progress event). Used for an honest "resuming from X" label; the
  // Rust side computes the real Range offset from the `.tmp` length.
  bytesReceived: number
  // ms epoch when the interruption was recorded.
  at: number
}

export type ModelRecord = {
  modelId: string
  // Last completed benchmark for this model. Null until the user runs the
  // first benchmark; cleared on `forget`.
  benchmark: BenchmarkResult | null
  // ISO timestamp (ms epoch) the model finished downloading. Null if never
  // downloaded successfully via this app.
  installedAt: number | null
  // A4 — present only while a partial download is known to exist on disk.
  // Absent/undefined means no known partial (don't fabricate a Resume label).
  interruptedDownload?: InterruptedDownload | null
}

export type ModelStoreSnapshot = {
  records: Record<string, ModelRecord>
  // The installed model the user chose for live AI. Selection is independent
  // from benchmarking: an active record may legitimately have benchmark:null.
  activeModelId: string | null
}

const MODELS_FILE = 'models.json'
const KEY_RECORDS = 'records'
const KEY_ACTIVE_MODEL = 'active_model_id'

export type StoreLike = {
  get<T>(key: string): Promise<T | undefined>
  set(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<boolean>
  save(): Promise<void>
}

export type ModelStoreFactory = (() => StoreLike) | null

export type ModelStoreDeps = {
  storeFactory: ModelStoreFactory
}

function isTauriRuntime(): boolean {
  return (
    typeof window !== 'undefined' &&
    ('__TAURI_INTERNALS__' in window || '__TAURI__' in window)
  )
}

let cachedLazyStore: LazyStore | null = null
function defaultLazyStoreFactory(): StoreLike {
  // Flush only complete snapshots through the serialized explicit save below.
  if (!cachedLazyStore)
    cachedLazyStore = new LazyStore(MODELS_FILE, { autoSave: false })
  return cachedLazyStore as unknown as StoreLike
}

const defaultDeps: ModelStoreDeps = {
  storeFactory: isTauriRuntime() ? defaultLazyStoreFactory : null,
}

let activeDeps: ModelStoreDeps = defaultDeps

export function __setModelStoreDeps(deps: ModelStoreDeps): void {
  activeDeps = deps
}

export function __resetModelStoreDeps(): void {
  activeDeps = defaultDeps
}

export const EMPTY_RECORDS: Record<string, ModelRecord> = {}

function isRecordsMap(v: unknown): v is Record<string, ModelRecord> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

type ModelState = ModelStoreSnapshot & {
  status: 'loading' | 'ready' | 'error'
  error: string | null
  hydrate: () => Promise<void>
  recordInstalled: (modelId: string, installedAt?: number) => Promise<void>
  selectModel: (modelId: string) => Promise<void>
  recordBenchmark: (
    modelId: string,
    benchmark: BenchmarkResult
  ) => Promise<void>
  // A4 — note that a download for `modelId` errored partway, so the picker can
  // surface a "Resume download" affordance. Upserts the record; preserves any
  // existing benchmark/installedAt.
  recordInterruptedDownload: (
    modelId: string,
    bytesReceived: number
  ) => Promise<void>
  // A4 — clear a recorded interruption (download completed, was removed, or the
  // partial was discarded). No-op when there's nothing to clear.
  clearInterruptedDownload: (modelId: string) => Promise<void>
  forget: (modelId: string) => Promise<void>
  retryPersist: () => Promise<void>
}

let persistenceQueue: Promise<void> = Promise.resolve()

function persist(set: (partial: Partial<ModelState>) => void): Promise<void> {
  const factory = activeDeps.storeFactory
  const { records, activeModelId } = useModelStore.getState()
  const write = persistenceQueue.then(async () => {
    try {
      if (factory) {
        const store = factory()
        const previous = [
          [KEY_RECORDS, await store.get(KEY_RECORDS)],
          [KEY_ACTIVE_MODEL, await store.get(KEY_ACTIVE_MODEL)],
        ] as const
        try {
          await store.set(KEY_RECORDS, records)
          await store.set(KEY_ACTIVE_MODEL, activeModelId)
          await store.save()
        } catch (error) {
          // The plugin saves every loaded cache on exit, even with autosave off.
          // Keep the unsaved draft in Zustand and restore both cached keys.
          let restorationFailed = false
          for (const [key, value] of previous) {
            try {
              if (value === undefined) await store.delete(key)
              else await store.set(key, value)
            } catch (restoreError) {
              restorationFailed = true
              log.error('persist.cache_restore_failed', { err: restoreError })
            }
          }
          if (restorationFailed) {
            const message =
              error instanceof Error ? error.message : String(error)
            throw new Error(
              `${message} ${strings.ai.picker.cacheRestoreFailed}`,
              { cause: error }
            )
          }
          throw error
        }
      }
      set({ error: null })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.error('persist.failed', { err })
      set({ error: message })
      throw new Error(message, { cause: err })
    }
  })
  persistenceQueue = write.catch(() => {})
  return write
}

export const useModelStore = create<ModelState>((set, get) => ({
  status: 'loading',
  records: EMPTY_RECORDS,
  activeModelId: null,
  error: null,

  hydrate: async () => {
    if (get().status === 'ready') return
    const factory = activeDeps.storeFactory
    if (!factory) {
      set({
        status: 'ready',
        records: EMPTY_RECORDS,
        activeModelId: null,
        error: null,
      })
      return
    }
    let loadedSnapshot: ModelStoreSnapshot | null = null
    try {
      const store = factory()
      const stored = await store.get<Record<string, ModelRecord>>(KEY_RECORDS)
      const active = await store.get<string | null>(KEY_ACTIVE_MODEL)
      let records = isRecordsMap(stored) ? stored : EMPTY_RECORDS
      let activeModelId =
        typeof active === 'string' && active.length > 0 ? active : null
      loadedSnapshot = { records, activeModelId }
      let repaired = false
      for (const [modelId, record] of Object.entries(records)) {
        // #422 retains unavailable model metadata until explicit removal.
        if (getModelUnavailableReason(modelId)) continue
        if (!record || record.installedAt == null) continue
        const files = await getDownloadRuntime().installState(modelId)
        if (files.model.exists && files.mmproj.exists) continue
        records = {
          ...records,
          [modelId]: { ...record, installedAt: null, benchmark: null },
        }
        if (activeModelId === modelId) activeModelId = null
        repaired = true
      }
      set({ status: 'ready', records, activeModelId, error: null })
      if (repaired) await persist(set).catch(() => {})
    } catch (err) {
      set({
        ...loadedSnapshot,
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
      })
    }
  },

  recordInstalled: async (modelId, installedAt) => {
    set((s) => ({
      records: {
        ...s.records,
        [modelId]: {
          modelId,
          benchmark: s.records[modelId]?.benchmark ?? null,
          installedAt: installedAt ?? Date.now(),
          // A4 — a completed install clears any prior interruption marker so a
          // stale Resume label can't linger after success.
          interruptedDownload: null,
        },
      },
    }))
    await persist(set)
  },

  selectModel: async (modelId) => {
    const unavailable = getModelUnavailableReason(modelId)
    if (unavailable) throw new Error(unavailable)
    const record = get().records[modelId]
    if (!record || record.installedAt == null) {
      throw new Error(`model is not installed: ${modelId}`)
    }
    set({ activeModelId: modelId })
    await persist(set)
  },

  recordInterruptedDownload: async (modelId, bytesReceived) => {
    set((s) => ({
      records: {
        ...s.records,
        [modelId]: {
          modelId,
          benchmark: s.records[modelId]?.benchmark ?? null,
          installedAt: s.records[modelId]?.installedAt ?? null,
          interruptedDownload: {
            bytesReceived: Math.max(0, Math.floor(bytesReceived)),
            at: Date.now(),
          },
        },
      },
    }))
    await persist(set)
  },

  clearInterruptedDownload: async (modelId) => {
    const existing = get().records[modelId]
    if (!existing || existing.interruptedDownload == null) return
    set((s) => ({
      records: {
        ...s.records,
        [modelId]: { ...existing, interruptedDownload: null },
      },
    }))
    await persist(set)
  },

  recordBenchmark: async (modelId, benchmark) => {
    set((s) => ({
      records: {
        ...s.records,
        [modelId]: {
          modelId,
          benchmark,
          installedAt: s.records[modelId]?.installedAt ?? Date.now(),
          // A4 — carry the interruption marker through rather than dropping it.
          // A normal benchmark follows a completed install, which already
          // clears this marker. Preserving it explicitly removes that ordering
          // dependency for any future benchmark entry point.
          interruptedDownload: s.records[modelId]?.interruptedDownload ?? null,
        },
      },
    }))
    await persist(set)
  },

  retryPersist: async () => {
    if (get().status !== 'ready') throw new Error('Model state has not loaded')
    await persist(set)
  },

  forget: async (modelId) => {
    set((s) => {
      const next = { ...s.records }
      delete next[modelId]
      return {
        records: next,
        activeModelId: s.activeModelId === modelId ? null : s.activeModelId,
      }
    })
    await persist(set)
  },
}))
