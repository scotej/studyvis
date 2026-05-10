// Persistent state for installed models + benchmark results. Mirrors the
// `useSettingsStore` pattern (LazyStore-backed, deps-injected for tests),
// but lives in its own `models.json` file so the settings store's
// type-narrow setters and DEFAULTS aren't polluted by per-model records.

import { LazyStore } from '@tauri-apps/plugin-store'
import { create } from 'zustand'

import type { BenchmarkResult } from './benchmark'

export type ModelRecord = {
  modelId: string
  // Last completed benchmark for this model. Null until the user runs the
  // first benchmark; cleared on `forget`.
  benchmark: BenchmarkResult | null
  // ISO timestamp (ms epoch) the model finished downloading. Null if never
  // downloaded successfully via this app.
  installedAt: number | null
}

export type ModelStoreSnapshot = {
  records: Record<string, ModelRecord>
  // The model id whose benchmark was most recently completed. V2-P5 reads
  // this to decide which paths to start the sample loop with.
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
  if (!cachedLazyStore) cachedLazyStore = new LazyStore(MODELS_FILE)
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
  recordBenchmark: (
    modelId: string,
    benchmark: BenchmarkResult
  ) => Promise<void>
  forget: (modelId: string) => Promise<void>
}

async function persist(
  set: (partial: Partial<ModelState>) => void
): Promise<void> {
  const factory = activeDeps.storeFactory
  if (!factory) return
  try {
    const store = factory()
    await store.set(
      KEY_RECORDS,
      useModelStore.getState().records as unknown as object
    )
    await store.set(KEY_ACTIVE_MODEL, useModelStore.getState().activeModelId)
    await store.save()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('modelStore.persist failed:', err)
    set({ error: message })
  }
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
    try {
      const store = factory()
      const stored = await store.get<Record<string, ModelRecord>>(KEY_RECORDS)
      const active = await store.get<string | null>(KEY_ACTIVE_MODEL)
      set({
        status: 'ready',
        records: isRecordsMap(stored) ? stored : EMPTY_RECORDS,
        activeModelId:
          typeof active === 'string' && active.length > 0 ? active : null,
        error: null,
      })
    } catch (err) {
      set({
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
        },
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
        },
      },
      activeModelId: modelId,
    }))
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
