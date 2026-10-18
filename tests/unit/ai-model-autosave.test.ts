import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { strings } from '@/strings'

const fixture = vi.hoisted(() => ({
  initial: {
    records: { first: { modelId: 'first', installedAt: 1, benchmark: null } },
    active_model_id: 'first',
  } as Record<string, unknown>,
  disk: {} as Record<string, unknown>,
  failSave: true,
  deferActive: false,
  releaseActive: null as (() => void) | null,
  exitFlush: null as (() => void) | null,
  failActiveOnce: false,
  failRestore: false,
  rejectRestore: false,
}))
vi.mock('@tauri-apps/plugin-store', () => ({
  LazyStore: class {
    private cache = structuredClone(fixture.initial)
    private autoSave: boolean | number
    constructor(_file: string, options?: { autoSave?: boolean | number }) {
      fixture.disk = structuredClone(fixture.initial)
      this.autoSave = options?.autoSave ?? 100
      fixture.exitFlush = () => {
        fixture.disk = structuredClone(this.cache)
      }
    }
    async get<T>(key: string): Promise<T | undefined> {
      return this.cache[key] as T
    }
    async set(key: string, value: unknown): Promise<void> {
      if (key === 'active_model_id' && fixture.deferActive) {
        fixture.deferActive = false
        await new Promise<void>((resolve) => {
          fixture.releaseActive = resolve
        })
      }
      if (key === 'active_model_id' && fixture.failActiveOnce) {
        fixture.failActiveOnce = false
        throw new Error('second key set failed')
      }
      if (key === 'records' && fixture.rejectRestore) {
        fixture.rejectRestore = false
        throw new Error('cache restoration failed')
      }
      this.cache[key] = structuredClone(value)
      if (this.autoSave !== false)
        setTimeout(
          () => {
            fixture.disk = structuredClone(this.cache)
          },
          typeof this.autoSave === 'number' ? this.autoSave : 100
        )
    }
    async delete(key: string): Promise<boolean> {
      delete this.cache[key]
      return true
    }
    async save(): Promise<void> {
      if (fixture.failSave) {
        if (fixture.failRestore) fixture.rejectRestore = true
        throw new Error('explicit save failed')
      }
      fixture.disk = structuredClone(this.cache)
    }
  },
}))
vi.mock('@/features/ai/download', () => ({
  getDownloadRuntime: () => ({
    installState: async () => ({
      model: { exists: true },
      mmproj: { exists: true },
    }),
  }),
}))
vi.mock('@/lib/log', () => ({ logger: { child: () => ({ error: vi.fn() }) } }))

beforeEach(() => {
  fixture.failSave = true
  fixture.deferActive = false
  fixture.releaseActive = null
  fixture.exitFlush = null
  fixture.failActiveOnce = false
  fixture.failRestore = false
  fixture.rejectRestore = false
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

test('the production model store never autosaves a partial or failed snapshot (#424)', async () => {
  vi.useFakeTimers()
  vi.stubGlobal('window', { __TAURI_INTERNALS__: {} })
  vi.resetModules()
  const { useModelStore } = await import('@/features/ai/modelStore')
  await useModelStore.getState().hydrate()
  fixture.deferActive = true
  const removing = useModelStore.getState().forget('first')
  const rejected = expect(removing).rejects.toThrow('explicit save failed')
  for (let i = 0; i < 8; i++) await Promise.resolve()
  expect(fixture.releaseActive).toBeTypeOf('function')
  await vi.advanceTimersByTimeAsync(150)
  // A plugin-default autosave would have removed records but kept the active id.
  expect(fixture.disk).toEqual(fixture.initial)
  fixture.releaseActive?.()
  await rejected
  await vi.advanceTimersByTimeAsync(150)
  expect(fixture.disk).toEqual(fixture.initial)
  expect(useModelStore.getState().error).toContain('explicit save failed')
  fixture.exitFlush?.()
  expect(fixture.disk).toEqual(fixture.initial)

  fixture.deferActive = false
  fixture.failSave = false
  await useModelStore.getState().retryPersist()
  expect(fixture.disk).toEqual({ records: {}, active_model_id: null })
  expect(useModelStore.getState().error).toBeNull()
})

test('a rejected second key is restored before native exit can save the cache (#424)', async () => {
  vi.stubGlobal('window', { __TAURI_INTERNALS__: {} })
  vi.resetModules()
  const { useModelStore } = await import('@/features/ai/modelStore')
  await useModelStore.getState().hydrate()
  fixture.failSave = false
  fixture.failActiveOnce = true
  await expect(useModelStore.getState().forget('first')).rejects.toThrow(
    'second key set failed'
  )
  fixture.exitFlush?.()
  expect(fixture.disk).toEqual(fixture.initial)
  expect(useModelStore.getState().records).toEqual({})
  expect(useModelStore.getState().activeModelId).toBeNull()
  await useModelStore.getState().retryPersist()
  expect(fixture.disk).toEqual({ records: {}, active_model_id: null })
})

test('failed cache restoration remains visible until a complete retry succeeds (#424)', async () => {
  vi.stubGlobal('window', { __TAURI_INTERNALS__: {} })
  vi.resetModules()
  const { useModelStore } = await import('@/features/ai/modelStore')
  await useModelStore.getState().hydrate()
  fixture.failRestore = true
  await expect(useModelStore.getState().forget('first')).rejects.toThrow(
    strings.ai.picker.cacheRestoreFailed
  )
  expect(useModelStore.getState().error).toContain(
    strings.ai.picker.cacheRestoreFailed
  )
  fixture.failSave = false
  await useModelStore.getState().retryPersist()
  expect(fixture.disk).toEqual({ records: {}, active_model_id: null })
  expect(useModelStore.getState().error).toBeNull()
})
