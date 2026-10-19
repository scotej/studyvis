import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import {
  getModelUnavailableReason,
  MODEL_UNAVAILABLE_ERROR,
} from '@/features/ai/models'

import {
  __resetModelStoreDeps,
  __setModelStoreDeps,
  BENCHMARK_SAMPLE_COUNT,
  emptyPickerState,
  downloadFraction,
  huggingfaceResolveUrl,
  modelCardGroups,
  modelDownloadUrls,
  progressEventToPhase,
  SUPPORTED_MODELS,
  summariseBenchmark,
  totalDownloadBytes,
  useModelStore,
  type ModelStoreDeps,
  type ProgressEvent,
} from '@/features/ai'

import {
  __setDownloadRuntime,
  __resetDownloadRuntime,
} from '@/features/ai/download'

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
  test('only the current managed Moondream entry is unavailable; pins and custom IDs remain intact', () => {
    const retired = SUPPORTED_MODELS.filter((spec) =>
      getModelUnavailableReason(spec.id)
    )
    expect(retired.map((spec) => spec.id)).toEqual(['moondream2'])
    expect(retired[0].unavailable).toEqual({
      engine: 'b9095',
      reason: MODEL_UNAVAILABLE_ERROR,
    })
    expect(retired[0].modelFile.sha256).toBe(
      '925bcb666baf69ed747e26121af287b16ae7764483be9548b1382f29783689a5'
    )
    expect(retired[0].mmprojFile.sha256).toBe(
      '4cc1cb3660d87ff56432ebeb7884ad35d67c48c7b9f6b2856f305e39c38eed8f'
    )
    for (const id of [null, undefined, 'advanced-custom-model'])
      expect(getModelUnavailableReason(id)).toBeNull()
  })

  test('retains the four historical tiers for compatibility, with three Gemma quants on Best', () => {
    expect(SUPPORTED_MODELS).toHaveLength(6)
    expect(SUPPORTED_MODELS.map((m) => m.defaultTier)).toEqual([
      'fastest',
      'balanced',
      'best',
      'best',
      'best',
      'heaviest',
    ])
  })

  // The ggml-org GGUF mirror is ungated (HF API verified 2026-07-25), so no
  // registered model requires a Hugging Face token anymore.
  test('no registered model is gated', () => {
    for (const spec of SUPPORTED_MODELS) {
      expect(spec.gated).toBe(false)
    }
  })

  test('Gemma quant variants share one family, repo, revision, and projector', () => {
    const gemmas = SUPPORTED_MODELS.filter((m) => m.quantFamily === 'gemma3-4b')
    expect(gemmas.map((m) => m.id)).toEqual([
      'gemma3-4b',
      'gemma3-4b-q8_0',
      'gemma3-4b-f16',
    ])
    expect(gemmas.map((m) => m.quantLabel)).toEqual(['Q4_K_M', 'Q8_0', 'f16'])
    const [q4, q8, f16] = gemmas
    for (const variant of [q8, f16]) {
      expect(variant.hfRepo).toBe(q4.hfRepo)
      expect(variant.hfRevision).toBe(q4.hfRevision)
      expect(variant.mmprojFile).toEqual(q4.mmprojFile)
    }
    // Distinct weights per quant — otherwise two ids would race one file.
    const modelShas = new Set(gemmas.map((m) => m.modelFile.sha256))
    expect(modelShas.size).toBe(3)
  })

  test('modelCardGroups collapses the Gemma quants into one card group', () => {
    const groups = modelCardGroups()
    expect(groups.map((g) => g.map((s) => s.id))).toEqual([
      ['moondream2'],
      ['qwen2_5-vl-3b'],
      ['gemma3-4b', 'gemma3-4b-q8_0', 'gemma3-4b-f16'],
      ['qwen2_5-vl-7b'],
    ])
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
      download_id: 'test-download',
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
    __setDownloadRuntime({
      installState: async () => ({
        model: { exists: true, size: 1 },
        mmproj: { exists: true, size: 1 },
      }),
    } as never)
    useModelStore.setState({
      status: 'loading',
      records: {},
      activeModelId: null,
      error: null,
    })
  })
  afterEach(() => {
    __resetModelStoreDeps()
    __resetDownloadRuntime()
  })

  test.each(['select', 'remove', 'remove-active'])(
    'failed %s save is explicit and a retry persists the current snapshot (#424)',
    async (operation) => {
      const records = Object.fromEntries(
        ['first', 'second'].map((modelId) => [
          modelId,
          { modelId, installedAt: 1, benchmark: null },
        ])
      )
      let disk = { records, active_model_id: 'first' }
      let pending = structuredClone(disk)
      let fail = true
      __setModelStoreDeps({
        storeFactory: () => ({
          get: async (key) =>
            structuredClone(disk[key as keyof typeof disk]) as never,
          set: async (key, value) => {
            pending = { ...pending, [key]: structuredClone(value) }
          },
          delete: async () => false,
          save: async () => {
            if (fail) throw new Error('Synthetic write denied')
            disk = structuredClone(pending)
          },
        }),
      })
      useModelStore.setState({
        status: 'ready',
        records,
        activeModelId: 'first',
        error: null,
      })
      const mutation =
        operation === 'select'
          ? useModelStore.getState().selectModel('second')
          : useModelStore
              .getState()
              .forget(operation === 'remove-active' ? 'first' : 'second')
      await expect(mutation).rejects.toThrow('Synthetic write denied')
      expect(useModelStore.getState().error).toBe('Synthetic write denied')
      expect(disk.active_model_id).toBe('first')
      expect(Object.keys(disk.records)).toHaveLength(2)
      fail = false
      await useModelStore.getState().retryPersist()
      expect(useModelStore.getState().error).toBeNull()
      expect(disk.active_model_id).toBe(useModelStore.getState().activeModelId)
      expect(disk.records).toEqual(useModelStore.getState().records)
    }
  )

  test.each(['selection-only', 'retained-record'])(
    'rehydration preserves unavailable %s without filesystem probes or migration writes (#424, #422)',
    async (mode) => {
      const { deps, store } = makeFakeDeps()
      const records =
        mode === 'retained-record'
          ? {
              moondream2: {
                modelId: 'moondream2',
                installedAt: 123,
                benchmark: summariseBenchmark({
                  samplesSec: [2, 3, 4],
                  completedAtSec: 99,
                }),
                interruptedDownload: { bytesReceived: 777, at: 789 },
              },
            }
          : {}
      store.data.set('records', records)
      store.data.set('active_model_id', 'moondream2')
      const before = structuredClone([...store.data])
      const write = vi.spyOn(store, 'set')
      const remove = vi.spyOn(store, 'delete')
      const paths = vi.fn()
      const installState = vi.fn(async () => ({
        model: { exists: false, size: 0 },
        mmproj: { exists: false, size: 0 },
      }))
      __setModelStoreDeps(deps)
      __setDownloadRuntime({ paths, installState } as never)

      await useModelStore.getState().hydrate()

      expect(useModelStore.getState()).toMatchObject({
        status: 'ready',
        activeModelId: 'moondream2',
        records,
        error: null,
      })
      expect([...store.data]).toEqual(before)
      expect(store.saved).toBe(0)
      expect(write).not.toHaveBeenCalled()
      expect(remove).not.toHaveBeenCalled()
      expect(paths).not.toHaveBeenCalled()
      expect(installState).not.toHaveBeenCalled()
    }
  )

  test.each(['Permission denied', 'Input/output error'])(
    'metadata %s preserves saved selection, benchmark, and retired records until Retry (#424)',
    async (message) => {
      const { deps, store } = makeFakeDeps()
      const benchmark = summariseBenchmark({
        samplesSec: [2, 3, 4],
        completedAtSec: 99,
      })
      const records = {
        'qwen2_5-vl-3b': {
          modelId: 'qwen2_5-vl-3b',
          installedAt: 123,
          benchmark,
        },
        moondream2: {
          modelId: 'moondream2',
          installedAt: 456,
          benchmark,
          interruptedDownload: { bytesReceived: 789, at: 999 },
        },
      }
      store.data.set('records', records)
      store.data.set('active_model_id', 'qwen2_5-vl-3b')
      const before = structuredClone([...store.data])
      let denied = true
      const installState = vi.fn(async () => {
        if (denied) throw new Error(message)
        return {
          model: { exists: true, size: 1 },
          mmproj: { exists: true, size: 1 },
        }
      })
      __setModelStoreDeps(deps)
      __setDownloadRuntime({ installState } as never)

      await useModelStore.getState().hydrate()
      expect(useModelStore.getState()).toMatchObject({
        status: 'error',
        error: message,
        records,
        activeModelId: 'qwen2_5-vl-3b',
      })
      expect([...store.data]).toEqual(before)
      expect(store.saved).toBe(0)
      expect(installState.mock.calls).toEqual([['qwen2_5-vl-3b']])

      denied = false
      await useModelStore.getState().hydrate()
      expect(useModelStore.getState()).toMatchObject({
        status: 'ready',
        error: null,
        records,
        activeModelId: 'qwen2_5-vl-3b',
      })
      expect([...store.data]).toEqual(before)
      expect(store.saved).toBe(0)
      expect(installState.mock.calls).toEqual([
        ['qwen2_5-vl-3b'],
        ['qwen2_5-vl-3b'],
      ])
    }
  )

  test('a later inspection error prevents an earlier missing-file repair from being persisted (#424)', async () => {
    const { deps, store } = makeFakeDeps()
    const benchmark = summariseBenchmark({
      samplesSec: [2, 3, 4],
      completedAtSec: 99,
    })
    const records = {
      first: { modelId: 'first', installedAt: 1, benchmark },
      second: { modelId: 'second', installedAt: 2, benchmark },
    }
    store.data.set('records', records)
    store.data.set('active_model_id', 'second')
    const before = structuredClone([...store.data])
    let denied = true
    __setModelStoreDeps(deps)
    __setDownloadRuntime({
      installState: async (id: string) => {
        if (id === 'second' && denied) throw new Error('Permission denied')
        return {
          model: { exists: id !== 'first', size: 1 },
          mmproj: { exists: true, size: 1 },
        }
      },
    } as never)
    await useModelStore.getState().hydrate()
    expect(useModelStore.getState()).toMatchObject({
      status: 'error',
      records,
      activeModelId: 'second',
    })
    expect([...store.data]).toEqual(before)
    expect(store.saved).toBe(0)

    denied = false
    await useModelStore.getState().hydrate()
    expect(useModelStore.getState().status).toBe('ready')
    expect(useModelStore.getState().records.first).toMatchObject({
      installedAt: null,
      benchmark: null,
    })
    expect(useModelStore.getState().records.second).toEqual(records.second)
    expect(useModelStore.getState().activeModelId).toBe('second')
    expect(store.saved).toBe(1)
  })

  test.each(['qwen2_5-vl-3b', 'unknown-installed-model'])(
    'rehydration cannot adopt removed active %s after its record save failed (#424)',
    async (modelId) => {
      const { deps, store } = makeFakeDeps()
      store.data.set('records', {
        [modelId]: { modelId, installedAt: 1, benchmark: null },
      })
      store.data.set('active_model_id', modelId)
      __setModelStoreDeps(deps)
      const installState = vi.fn(async () => ({
        model: { exists: false, size: 0 },
        mmproj: { exists: true, size: 1 },
      }))
      __setDownloadRuntime({
        installState,
      } as never)
      await useModelStore.getState().hydrate()
      expect(useModelStore.getState().activeModelId).toBeNull()
      expect(useModelStore.getState().records[modelId].installedAt).toBeNull()
      await expect(
        useModelStore.getState().selectModel(modelId)
      ).rejects.toThrow('not installed')
      expect(store.data.get('active_model_id')).toBeNull()
      expect(installState).toHaveBeenCalledExactlyOnceWith(modelId)
    }
  )

  test('overlapping mutations save coherent snapshots in invocation order (#424)', async () => {
    const saved: Array<{ records: unknown; active: unknown }> = []
    let pending: Record<string, unknown> = {}
    let releaseFirst!: () => void
    let calls = 0
    __setModelStoreDeps({
      storeFactory: () => ({
        get: async () => undefined,
        set: async (key, value) => {
          pending[key] = structuredClone(value)
        },
        delete: async () => false,
        save: async () => {
          if (++calls === 1)
            await new Promise<void>((resolve) => {
              releaseFirst = resolve
            })
          saved.push({
            records: pending.records,
            active: pending.active_model_id,
          })
          pending = {}
        },
      }),
    })
    useModelStore.setState({
      status: 'ready',
      records: {
        first: { modelId: 'first', installedAt: 1, benchmark: null },
        second: { modelId: 'second', installedAt: 1, benchmark: null },
      },
      activeModelId: 'first',
    })
    const first = useModelStore.getState().selectModel('second')
    await vi.waitFor(() => expect(releaseFirst).toBeTypeOf('function'))
    const second = useModelStore.getState().forget('first')
    releaseFirst()
    await Promise.all([first, second])
    expect(Object.keys(saved[0].records as object)).toEqual(['first', 'second'])
    expect(saved[0].active).toBe('second')
    expect(Object.keys(saved[1].records as object)).toEqual(['second'])
    expect(saved[1].active).toBe('second')
  })

  test('retained Moondream selection hydrates without mutation, refuses new activation, and remains explicitly removable', async () => {
    const { deps, store } = makeFakeDeps()
    const record = {
      modelId: 'moondream2',
      installedAt: 123,
      benchmark: summariseBenchmark({
        samplesSec: [2, 3, 4],
        completedAtSec: 99,
      }),
      interruptedDownload: { bytesReceived: 2048, at: 456 },
    }
    store.data.set('records', { moondream2: record })
    store.data.set('active_model_id', 'moondream2')
    const before = JSON.stringify([...store.data])
    __setModelStoreDeps(deps)
    await useModelStore.getState().hydrate()
    expect(useModelStore.getState().activeModelId).toBe('moondream2')
    expect(useModelStore.getState().records).toEqual({ moondream2: record })
    expect(JSON.stringify([...store.data])).toBe(before)
    expect(store.saved).toBe(0)
    const hydrated = useModelStore.getState()
    await expect(hydrated.selectModel('moondream2')).rejects.toThrow(
      'unavailable'
    )
    expect(useModelStore.getState()).toBe(hydrated)
    expect(JSON.stringify([...store.data])).toBe(before)
    expect(store.saved).toBe(0)
    await hydrated.forget('moondream2')
    expect(useModelStore.getState().activeModelId).toBeNull()
    expect(useModelStore.getState().records.moondream2).toBeUndefined()
    expect(store.saved).toBe(1)
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

  test('selectModel persists an installed model without requiring a benchmark', async () => {
    const { deps, store } = makeFakeDeps()
    __setModelStoreDeps(deps)
    await useModelStore.getState().hydrate()

    await useModelStore.getState().recordInstalled('qwen2_5-vl-3b', 200)
    await useModelStore.getState().selectModel('qwen2_5-vl-3b')

    const state = useModelStore.getState()
    expect(state.activeModelId).toBe('qwen2_5-vl-3b')
    expect(state.records['qwen2_5-vl-3b']?.benchmark).toBeNull()
    expect(store.data.get('active_model_id')).toBe('qwen2_5-vl-3b')
    expect(store.saved).toBe(2)
  })

  test('selectModel rejects a model with no stored installation record', async () => {
    const { deps, store } = makeFakeDeps()
    __setModelStoreDeps(deps)
    await useModelStore.getState().hydrate()

    await expect(
      useModelStore.getState().selectModel('qwen2_5-vl-3b')
    ).rejects.toThrow('model is not installed: qwen2_5-vl-3b')
    expect(useModelStore.getState().activeModelId).toBeNull()
    expect(store.saved).toBe(0)
  })

  test('selectModel rejects a partial-download record', async () => {
    const { deps } = makeFakeDeps()
    __setModelStoreDeps(deps)
    await useModelStore.getState().hydrate()
    await useModelStore
      .getState()
      .recordInterruptedDownload('qwen2_5-vl-3b', 1024)

    await expect(
      useModelStore.getState().selectModel('qwen2_5-vl-3b')
    ).rejects.toThrow('model is not installed: qwen2_5-vl-3b')
    expect(useModelStore.getState().activeModelId).toBeNull()
  })

  test('recordBenchmark stores the result without changing the active model', async () => {
    const { deps, store } = makeFakeDeps()
    __setModelStoreDeps(deps)
    await useModelStore.getState().hydrate()
    await useModelStore.getState().recordInstalled('qwen2_5-vl-3b', 100)
    await useModelStore.getState().recordInstalled('gemma3-4b', 200)
    await useModelStore.getState().selectModel('qwen2_5-vl-3b')
    const result = summariseBenchmark({
      samplesSec: [2, 3, 4],
      completedAtSec: 99,
    })
    await useModelStore.getState().recordBenchmark('gemma3-4b', result)

    const state = useModelStore.getState()
    expect(state.activeModelId).toBe('qwen2_5-vl-3b')
    expect(state.records['gemma3-4b']?.benchmark?.p95Sec).toBe(4)
    expect(store.data.get('active_model_id')).toBe('qwen2_5-vl-3b')
    expect(store.saved).toBe(4)
  })

  test('switching models preserves each installation and benchmark record', async () => {
    const { deps } = makeFakeDeps()
    __setModelStoreDeps(deps)
    await useModelStore.getState().hydrate()
    await useModelStore.getState().recordInstalled('qwen2_5-vl-3b', 100)
    await useModelStore.getState().recordInstalled('gemma3-4b', 200)
    await useModelStore
      .getState()
      .recordBenchmark(
        'gemma3-4b',
        summariseBenchmark({ samplesSec: [10, 11, 12], completedAtSec: 0 })
      )
    await useModelStore.getState().selectModel('qwen2_5-vl-3b')
    await useModelStore.getState().selectModel('gemma3-4b')

    const state = useModelStore.getState()
    expect(useModelStore.getState().activeModelId).toBe('gemma3-4b')
    expect(state.records['qwen2_5-vl-3b']?.installedAt).toBe(100)
    expect(state.records['qwen2_5-vl-3b']?.benchmark).toBeNull()
    expect(state.records['gemma3-4b']?.installedAt).toBe(200)
    expect(state.records['gemma3-4b']?.benchmark?.p95Sec).toBe(12)
  })

  test('forget clears only a matching active selection', async () => {
    const { deps, store } = makeFakeDeps()
    __setModelStoreDeps(deps)
    await useModelStore.getState().hydrate()
    await useModelStore.getState().recordInstalled('moondream2', 100)
    await useModelStore.getState().recordInstalled('gemma3-4b', 200)
    await useModelStore.getState().selectModel('gemma3-4b')

    await useModelStore.getState().forget('moondream2')
    expect(useModelStore.getState().records['moondream2']).toBeUndefined()
    expect(useModelStore.getState().activeModelId).toBe('gemma3-4b')

    await useModelStore.getState().forget('gemma3-4b')
    const state = useModelStore.getState()
    expect(state.records['gemma3-4b']).toBeUndefined()
    expect(state.activeModelId).toBeNull()
    expect(store.data.get('active_model_id')).toBeNull()
  })

  // I83 — a failed read used to be terminal for the whole process:
  // `status: 'error'` left activeModelId null, so no session could run AI, and
  // the one surface able to re-read it (ModelPickerContainer) only retried on
  // 'loading'. Its gate is now `status !== 'ready'`, which these two pin.
  test('hydrate records an error without inventing a model', async () => {
    const throwing: ModelStoreDeps = {
      storeFactory: () => ({
        get: async <T>(): Promise<T | undefined> => {
          throw new Error('models.json is locked')
        },
        set: async () => {},
        delete: async () => true,
        save: async () => {},
      }),
    }
    __setModelStoreDeps(throwing)
    await useModelStore.getState().hydrate()
    const after = useModelStore.getState()
    expect(after.status).toBe('error')
    expect(after.error).toContain('locked')
    expect(after.activeModelId).toBeNull()
  })

  test('a second hydrate after an error can still reach ready', async () => {
    // The recovery this enables: the user opens Settings → AI, that mount
    // retries, and AI works for the rest of the process without a restart.
    let calls = 0
    const flaky: ModelStoreDeps = {
      storeFactory: () => ({
        get: async <T>(key: string): Promise<T | undefined> => {
          calls += 1
          if (calls === 1) throw new Error('transient AV lock')
          return (key === 'active_model_id' ? 'qwen2_5-vl-3b' : {}) as T
        },
        set: async () => {},
        delete: async () => true,
        save: async () => {},
      }),
    }
    __setModelStoreDeps(flaky)
    await useModelStore.getState().hydrate()
    expect(useModelStore.getState().status).toBe('error')

    await useModelStore.getState().hydrate()
    const after = useModelStore.getState()
    expect(after.status).toBe('ready')
    expect(after.activeModelId).toBe('qwen2_5-vl-3b')
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
