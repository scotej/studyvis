import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { startMirrorAiRuntime } from '@/features/mirror/aiRuntime'
import {
  __resetSidecarRuntime,
  __setSidecarRuntime,
  useSidecarStore,
  type SidecarRuntime,
} from '@/features/ai/sidecar'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

function runtime() {
  return {
    modelPaths: vi.fn(async () => ({
      modelPath: '/models/selected/model.gguf',
      mmprojPath: '/models/selected/mmproj.gguf',
    })),
    start: vi.fn(async () => 12345 as number | null),
    stop: vi.fn(async () => {}),
    lastError: () => null as string | null,
  }
}

describe('mirrored session AI ownership', () => {
  test('starts the selected local model without requiring browser capture', async () => {
    const deps = runtime()
    const onStartFail = vi.fn()
    const engine = startMirrorAiRuntime(
      { modelId: 'selected', onStartFail },
      deps
    )
    expect(await engine.ready).toBe(true)
    expect(deps.modelPaths).toHaveBeenCalledWith('selected')
    expect(deps.start).toHaveBeenCalledWith({
      modelPath: '/models/selected/model.gguf',
      mmprojPath: '/models/selected/mmproj.gguf',
      ctxSize: 4096,
    })
    expect(deps.stop).not.toHaveBeenCalled()
    expect(onStartFail).not.toHaveBeenCalled()
    await engine.stop()
    expect(deps.stop).toHaveBeenCalledTimes(1)
  })

  test('claims teardown immediately and never starts after a delayed path lookup', async () => {
    const paths = deferred<{ modelPath: string; mmprojPath: string }>()
    const deps = runtime()
    deps.modelPaths = vi.fn(() => paths.promise)
    const onStartFail = vi.fn()
    const engine = startMirrorAiRuntime(
      { modelId: 'selected', onStartFail },
      deps
    )
    const stopping = engine.stop()
    expect(deps.stop).toHaveBeenCalledTimes(1)
    expect(engine.stop()).toBe(stopping)
    paths.resolve({ modelPath: '/old/model', mmprojPath: '/old/projector' })
    await stopping
    expect(await engine.ready).toBe(false)
    expect(deps.start).not.toHaveBeenCalled()
    expect(onStartFail).not.toHaveBeenCalled()
  })

  test('a late canceled native start cannot report a false failure', async () => {
    const start = deferred<number | null>()
    const deps = runtime()
    deps.start = vi.fn(() => start.promise)
    const onStartFail = vi.fn()
    const engine = startMirrorAiRuntime(
      { modelId: 'selected', onStartFail },
      deps
    )
    await Promise.resolve()
    expect(deps.start).toHaveBeenCalledTimes(1)
    const stopping = engine.stop()
    expect(deps.stop).toHaveBeenCalledTimes(1)
    start.reject(new Error('superseded'))
    await stopping
    expect(await engine.ready).toBe(false)
    expect(onStartFail).not.toHaveBeenCalled()
  })

  test('reports setup failures without pretending text AI is ready', async () => {
    const deps = runtime()
    deps.start.mockResolvedValue(null)
    deps.lastError = () => 'engine_not_installed'
    const onStartFail = vi.fn()
    const engine = startMirrorAiRuntime(
      { modelId: 'selected', onStartFail },
      deps
    )
    expect(await engine.ready).toBe(false)
    expect(onStartFail).toHaveBeenCalledWith(
      'sidecar_start_failed',
      'engine_not_installed'
    )
    await engine.stop()
  })

  test('missing model files never spawn the engine', async () => {
    const deps = runtime()
    deps.modelPaths.mockRejectedValue(new Error('missing'))
    const onStartFail = vi.fn()
    const engine = startMirrorAiRuntime(
      { modelId: 'selected', onStartFail },
      deps
    )
    expect(await engine.ready).toBe(false)
    expect(deps.start).not.toHaveBeenCalled()
    expect(onStartFail).toHaveBeenCalledWith('model_files_missing', 'missing')
    await engine.stop()
  })

  test('consumes stop rejection while startup is still pending', async () => {
    const paths = deferred<{ modelPath: string; mmprojPath: string }>()
    const deps = runtime()
    deps.modelPaths = vi.fn(() => paths.promise)
    deps.stop.mockRejectedValue(new Error('stop failed'))
    const engine = startMirrorAiRuntime(
      { modelId: 'selected', onStartFail: vi.fn() },
      deps
    )
    const stopping = engine.stop()
    await new Promise<void>((resolve) => setImmediate(resolve))
    paths.resolve({ modelPath: '/old/model', mmprojPath: '/old/projector' })
    await expect(stopping).resolves.toBeUndefined()
    expect(deps.stop).toHaveBeenCalledTimes(1)
  })
})

describe('mirrored model replacement uses the singleton sidecar lifecycle', () => {
  beforeEach(() => {
    __resetSidecarRuntime()
    useSidecarStore.setState({
      status: 'idle',
      port: null,
      model: null,
      mmproj: null,
      ctxSize: null,
      healthy: false,
      lastError: null,
      lastHealthCheckAt: null,
      pollHandle: null,
      hardwareIdentity: null,
    })
  })
  afterEach(() => __resetSidecarRuntime())

  test('waits for the old stop before starting a replacement and ignores the old completion', async () => {
    const oldStart = deferred<{ port: number; hardwareIdentity: null }>()
    const oldStop = deferred<void>()
    const nativeStart = vi.fn<SidecarRuntime['start']>()
    nativeStart
      .mockImplementationOnce(() => oldStart.promise)
      .mockResolvedValue({ port: 23456, hardwareIdentity: null })
    const nativeStop = vi.fn<SidecarRuntime['stop']>()
    nativeStop.mockImplementationOnce(() => oldStop.promise).mockResolvedValue()
    __setSidecarRuntime({
      start: nativeStart,
      stop: nativeStop,
      status: vi.fn(),
      fetchHealth: async () => true,
      setInterval: () => 1,
      clearInterval: () => {},
      getAiFeaturesEnabled: () => true,
      getEngineAutoInstall: () => true,
    })
    const onOldFailure = vi.fn()
    const deps = {
      modelPaths: async (modelId: string) => ({
        modelPath: `/models/${modelId}/model.gguf`,
        mmprojPath: `/models/${modelId}/mmproj.gguf`,
      }),
      start: useSidecarStore.getState().start,
      stop: useSidecarStore.getState().stop,
      lastError: () => useSidecarStore.getState().lastError,
    }
    const old = startMirrorAiRuntime(
      { modelId: 'old', onStartFail: onOldFailure },
      deps
    )
    await Promise.resolve()
    expect(nativeStart).toHaveBeenCalledTimes(1)
    const stopping = old.stop()
    const replacement = startMirrorAiRuntime(
      { modelId: 'replacement', onStartFail: vi.fn() },
      deps
    )
    await Promise.resolve()
    expect(nativeStart).toHaveBeenCalledTimes(1)
    oldStop.resolve()
    expect(await replacement.ready).toBe(true)
    oldStart.resolve({ port: 12345, hardwareIdentity: null })
    await stopping
    expect(useSidecarStore.getState()).toMatchObject({
      status: 'running',
      port: 23456,
      model: '/models/replacement/model.gguf',
    })
    expect(onOldFailure).not.toHaveBeenCalled()
    await replacement.stop()
    expect(useSidecarStore.getState().status).toBe('idle')
  })
})
