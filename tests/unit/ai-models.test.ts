import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import {
  __resetModelStoreDeps,
  __setModelStoreDeps,
  BENCHMARK_SAMPLE_COUNT,
  emptyPickerState,
  downloadFraction,
  huggingfaceResolveUrl,
  modelDownloadUrls,
  progressEventToPhase,
  SUPPORTED_MODELS,
  summariseBenchmark,
  totalDownloadBytes,
  useModelStore,
  type ModelStoreDeps,
  type ProgressEvent,
} from '@/features/ai'

class FakeStore {
  data = new Map<string, unknown>()
  saved = 0
  async get<T>(key: string): Promise<T | undefined> {
    return this.data.get(key) as T | undefined
  }
  async set(key: string, value: unknown): Promise<void> {
    this.data.set(key, value)
  }
  async delete(key: string): Promise<boolean> {
    return this.data.delete(key)
  }
  async save(): Promise<void> {
    this.saved += 1
  }
}

function makeFakeDeps(): { deps: ModelStoreDeps; store: FakeStore } {
  const store = new FakeStore()
  return {
    store,
    deps: { storeFactory: () => store },
  }
}

describe('models registry', () => {
  test('exposes all four ARCHITECTURE.md §8 tiers', () => {
    expect(SUPPORTED_MODELS).toHaveLength(4)
    expect(SUPPORTED_MODELS.map((m) => m.defaultTier)).toEqual([
      'fastest',
      'balanced',
      'best',
      'heaviest',
    ])
  })

  test('marks Gemma as gated, Qwen + Moondream as not gated', () => {
    const ids = Object.fromEntries(SUPPORTED_MODELS.map((m) => [m.id, m.gated]))
    expect(ids['gemma3-4b']).toBe(true)
    expect(ids['qwen2_5-vl-3b']).toBe(false)
    expect(ids['qwen2_5-vl-7b']).toBe(false)
    expect(ids['moondream2']).toBe(false)
  })

  test('builds resolve URLs in the canonical hf.co/<repo>/resolve/<rev>/<file> shape', () => {
    expect(
      huggingfaceResolveUrl(
        'ggml-org/Qwen2.5-VL-3B-Instruct-GGUF',
        'foo.gguf',
        'abc123'
      )
    ).toBe(
      'https://huggingface.co/ggml-org/Qwen2.5-VL-3B-Instruct-GGUF/resolve/abc123/foo.gguf'
    )
  })

  // #47 D3 — every tier pins a repo commit hash so an upstream re-upload to
  // main can't invalidate the manifest's sizeBytes/sha256 mid-release-cycle.
  test('every spec pins a 40-hex hfRevision', () => {
    for (const spec of SUPPORTED_MODELS) {
      expect(spec.hfRevision).toMatch(/^[0-9a-f]{40}$/)
    }
  })

  test('totalDownloadBytes sums model + mmproj', () => {
    const spec = SUPPORTED_MODELS[0]
    expect(totalDownloadBytes(spec)).toBe(
      spec.modelFile.sizeBytes + spec.mmprojFile.sizeBytes
    )
  })

  test('modelDownloadUrls resolves both files at the pinned revision', () => {
    const spec = SUPPORTED_MODELS[1]
    const urls = modelDownloadUrls(spec)
    expect(urls.model).toBe(
      `https://huggingface.co/${spec.hfRepo}/resolve/${spec.hfRevision}/${spec.modelFile.filename}`
    )
    expect(urls.mmproj).toBe(
      `https://huggingface.co/${spec.hfRepo}/resolve/${spec.hfRevision}/${spec.mmprojFile.filename}`
    )
  })
})

describe('summariseBenchmark', () => {
  test('with three monotonic samples picks median + max + applies sample-interval floor', () => {
    const result = summariseBenchmark({
      samplesSec: [3, 4, 9],
      completedAtSec: 100,
    })
    expect(result.p50Sec).toBe(4)
    expect(result.p95Sec).toBe(9)
    // ceil(9 + 1) = 10, max(5, 10) = 10
    expect(result.sampleIntervalSec).toBe(10)
  })

  test('clamps the sample interval at 5 s for small p95', () => {
    const result = summariseBenchmark({
      samplesSec: [1, 1.2, 1.5],
      completedAtSec: 0,
    })
    expect(result.sampleIntervalSec).toBe(5)
  })

  test('handles even-length sample arrays', () => {
    const result = summariseBenchmark({
      samplesSec: [1, 2, 3, 4],
      completedAtSec: 0,
    })
    expect(result.p50Sec).toBe(2.5)
    expect(result.p95Sec).toBe(4)
  })

  test('rejects empty input', () => {
    expect(() =>
      summariseBenchmark({ samplesSec: [], completedAtSec: 0 })
    ).toThrow()
  })
})

describe('progressEventToPhase / downloadFraction', () => {
  function makeProgress(overrides: Partial<ProgressEvent> = {}): ProgressEvent {
    return {
      model_id: 'moondream2',
      file: 'model',
      file_index: 0,
      file_count: 2,
      bytes_received: 0,
      total_bytes: 0,
      phase: 'downloading',
      error: null,
      ...overrides,
    }
  }

  test('maps downloading-model and downloading-mmproj phases', () => {
    expect(progressEventToPhase(makeProgress({ file: 'model' }))).toBe(
      'downloading-model'
    )
    expect(progressEventToPhase(makeProgress({ file: 'mmproj' }))).toBe(
      'downloading-mmproj'
    )
  })

  test('maps verifying phase', () => {
    expect(progressEventToPhase(makeProgress({ phase: 'verifying' }))).toBe(
      'verifying'
    )
  })

  test('returns null for terminal phases (handled by coordinator)', () => {
    expect(progressEventToPhase(makeProgress({ phase: 'done' }))).toBeNull()
    expect(progressEventToPhase(makeProgress({ phase: 'failed' }))).toBeNull()
    expect(
      progressEventToPhase(makeProgress({ phase: 'cancelled' }))
    ).toBeNull()
  })

  test('downloadFraction interpolates across two-file pair', () => {
    // Half through file 1 of 2
    expect(
      downloadFraction(
        makeProgress({
          file_index: 0,
          file_count: 2,
          bytes_received: 50,
          total_bytes: 100,
        })
      )
    ).toBeCloseTo(0.25)
    // Halfway through file 2 of 2
    expect(
      downloadFraction(
        makeProgress({
          file_index: 1,
          file_count: 2,
          bytes_received: 50,
          total_bytes: 100,
        })
      )
    ).toBeCloseTo(0.75)
  })

  test('downloadFraction returns null when total_bytes unknown', () => {
    expect(downloadFraction(makeProgress({ total_bytes: 0 }))).toBeNull()
  })
})

describe('emptyPickerState', () => {
  test('produces an idle entry per registered model', () => {
    const entries = emptyPickerState()
    expect(Object.keys(entries).sort()).toEqual(
      SUPPORTED_MODELS.map((m) => m.id).sort()
    )
    for (const id of Object.keys(entries)) {
      expect(entries[id].phase).toBe('idle')
      expect(entries[id].installState).toEqual({
        modelExists: false,
        mmprojExists: false,
      })
      expect(entries[id].record).toBeNull()
    }
  })
})

describe('useModelStore (LazyStore-backed)', () => {
  beforeEach(() => {
    useModelStore.setState({
      status: 'loading',
      records: {},
      activeModelId: null,
      error: null,
    })
  })
  afterEach(() => {
    __resetModelStoreDeps()
  })

  test('hydrate populates from store and persists subsequent writes', async () => {
    const { deps, store } = makeFakeDeps()
    store.data.set('records', {
      'qwen2_5-vl-3b': {
        modelId: 'qwen2_5-vl-3b',
        benchmark: null,
        installedAt: 100,
      },
    })
    store.data.set('active_model_id', 'qwen2_5-vl-3b')
    __setModelStoreDeps(deps)

    await useModelStore.getState().hydrate()
    const after = useModelStore.getState()
    expect(after.status).toBe('ready')
    expect(after.records['qwen2_5-vl-3b']?.installedAt).toBe(100)
    expect(after.activeModelId).toBe('qwen2_5-vl-3b')

    await useModelStore.getState().recordInstalled('moondream2', 200)
    expect(useModelStore.getState().records['moondream2']?.installedAt).toBe(
      200
    )
    expect(store.saved).toBe(1)
    expect(
      (store.data.get('records') as Record<string, unknown>)['moondream2']
    ).toBeDefined()
  })

  test('recordBenchmark sets activeModelId and stores the result', async () => {
    const { deps, store } = makeFakeDeps()
    __setModelStoreDeps(deps)
    await useModelStore.getState().hydrate()
    const result = summariseBenchmark({
      samplesSec: [2, 3, 4],
      completedAtSec: 99,
    })
    await useModelStore.getState().recordBenchmark('moondream2', result)
    const state = useModelStore.getState()
    expect(state.activeModelId).toBe('moondream2')
    expect(state.records['moondream2']?.benchmark?.p95Sec).toBe(4)
    expect(store.saved).toBe(1)
  })

  test('forget removes the record and clears activeModelId if it pointed there', async () => {
    const { deps } = makeFakeDeps()
    __setModelStoreDeps(deps)
    await useModelStore.getState().hydrate()
    await useModelStore
      .getState()
      .recordBenchmark(
        'gemma3-4b',
        summariseBenchmark({ samplesSec: [10, 11, 12], completedAtSec: 0 })
      )
    expect(useModelStore.getState().activeModelId).toBe('gemma3-4b')
    await useModelStore.getState().forget('gemma3-4b')
    const state = useModelStore.getState()
    expect(state.records['gemma3-4b']).toBeUndefined()
    expect(state.activeModelId).toBeNull()
  })

  test('hydrate without a Tauri store factory falls back to defaults', async () => {
    __setModelStoreDeps({ storeFactory: null })
    await useModelStore.getState().hydrate()
    const state = useModelStore.getState()
    expect(state.status).toBe('ready')
    expect(state.records).toEqual({})
    expect(state.activeModelId).toBeNull()
  })

  test('A4 — recordInterruptedDownload upserts a partial marker and persists', async () => {
    const { deps, store } = makeFakeDeps()
    __setModelStoreDeps(deps)
    await useModelStore.getState().hydrate()
    await useModelStore
      .getState()
      .recordInterruptedDownload('moondream2', 2_900_000_000)
    const rec = useModelStore.getState().records['moondream2']
    expect(rec?.interruptedDownload?.bytesReceived).toBe(2_900_000_000)
    expect(rec?.installedAt).toBeNull()
    expect(store.saved).toBe(1)
  })

  test('A4 — recordInterruptedDownload preserves an existing benchmark', async () => {
    const { deps } = makeFakeDeps()
    __setModelStoreDeps(deps)
    await useModelStore.getState().hydrate()
    await useModelStore
      .getState()
      .recordBenchmark(
        'qwen2_5-vl-3b',
        summariseBenchmark({ samplesSec: [3, 4, 5], completedAtSec: 0 })
      )
    await useModelStore
      .getState()
      .recordInterruptedDownload('qwen2_5-vl-3b', 1_000)
    const rec = useModelStore.getState().records['qwen2_5-vl-3b']
    expect(rec?.benchmark?.p95Sec).toBe(5)
    expect(rec?.interruptedDownload?.bytesReceived).toBe(1_000)
  })

  test('A4 — recordInstalled clears any prior interruption marker', async () => {
    const { deps } = makeFakeDeps()
    __setModelStoreDeps(deps)
    await useModelStore.getState().hydrate()
    await useModelStore.getState().recordInterruptedDownload('moondream2', 500)
    expect(
      useModelStore.getState().records['moondream2']?.interruptedDownload
    ).not.toBeNull()
    await useModelStore.getState().recordInstalled('moondream2', 1234)
    const rec = useModelStore.getState().records['moondream2']
    expect(rec?.installedAt).toBe(1234)
    expect(rec?.interruptedDownload).toBeNull()
  })

  test('A4 — recordBenchmark preserves an existing interruption marker', async () => {
    const { deps } = makeFakeDeps()
    __setModelStoreDeps(deps)
    await useModelStore.getState().hydrate()
    await useModelStore
      .getState()
      .recordInterruptedDownload('moondream2', 4_096)
    await useModelStore
      .getState()
      .recordBenchmark(
        'moondream2',
        summariseBenchmark({ samplesSec: [1, 2, 3], completedAtSec: 0 })
      )
    const rec = useModelStore.getState().records['moondream2']
    expect(rec?.benchmark?.p95Sec).toBe(3)
    // Carried through rather than dropped — recordBenchmark no longer relies on
    // recordInstalled having cleared the field first.
    expect(rec?.interruptedDownload?.bytesReceived).toBe(4_096)
  })

  test('A4 — clearInterruptedDownload is a no-op when nothing is recorded', async () => {
    const { deps, store } = makeFakeDeps()
    __setModelStoreDeps(deps)
    await useModelStore.getState().hydrate()
    await useModelStore.getState().clearInterruptedDownload('moondream2')
    // No record existed, so nothing persisted.
    expect(store.saved).toBe(0)
    await useModelStore.getState().recordInterruptedDownload('moondream2', 9)
    const savesAfterRecord = store.saved
    await useModelStore.getState().clearInterruptedDownload('moondream2')
    expect(store.saved).toBe(savesAfterRecord + 1)
    expect(
      useModelStore.getState().records['moondream2']?.interruptedDownload
    ).toBeNull()
  })
})

describe('benchmark sample count', () => {
  test('matches the documented n=3', () => {
    expect(BENCHMARK_SAMPLE_COUNT).toBe(3)
  })
})
