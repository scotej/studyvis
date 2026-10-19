import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import {
  __resetBenchmarkRuntime,
  __setBenchmarkRuntime,
  aiHardwareIdentitiesEqual,
  clearCurrentAiHardwareIdentity,
  inferenceEngineFingerprintFor,
  isBenchmarkStale,
  runBenchmark,
  setCurrentAiHardwareIdentity,
  summariseBenchmark,
  SUPPORTED_MODELS,
  type AiHardwareIdentity,
  type BenchmarkProgress,
  type BenchmarkRuntime,
  type ChatCompletionRequest,
} from '@/features/ai'

import {
  getBenchmarkRuntime,
  waitForBenchmarkHealthy,
  useBenchmarkActivity,
} from '@/features/ai/benchmark'
import {
  __setSidecarRuntime,
  __resetSidecarRuntime,
  useSidecarStore,
  type SidecarRuntime,
} from '@/features/ai/sidecar'
import { useSettingsStore } from '@/stores/settingsStore'

const TEST_HARDWARE_IDENTITY: AiHardwareIdentity = {
  selection: 'device:Vulkan0',
  topology: [{ id: 'Vulkan0', label: 'NVIDIA RTX 4080' }],
}

function makeFakeRuntime({
  perCallSec,
  startThrows,
  healthThrows,
  prepareImagesThrows,
}: {
  perCallSec: number[]
  startThrows?: Error
  healthThrows?: Error
  prepareImagesThrows?: Error
}): {
  runtime: BenchmarkRuntime
  startedWith: {
    modelPath: string
    mmprojPath: string | null
    ctxSize: number
  }[]
  stops: number
  bodies: ChatCompletionRequest[]
} {
  let nextSampleIndex = 0
  const startedWith: {
    modelPath: string
    mmprojPath: string | null
    ctxSize: number
  }[] = []
  const bodies: ChatCompletionRequest[] = []
  let stops = 0
  const runtime: BenchmarkRuntime = {
    prepareImages: async () => {
      if (prepareImagesThrows) throw prepareImagesThrows
      // Distinct face/screen base64 so the test can assert the two image
      // slots carry different content (the live tick sends a camera frame +
      // a larger screen frame, never the same image twice).
      return {
        faceBase64: 'FACE',
        screenBase64: 'SCREEN',
        mimeType: 'image/jpeg',
      }
    },
    startSidecar: async (params) => {
      if (startThrows) throw startThrows
      startedWith.push(params)
      return { port: 31337, hardwareIdentity: TEST_HARDWARE_IDENTITY }
    },
    stopSidecar: async () => {
      stops += 1
    },
    waitForHealthy: async () => {
      if (healthThrows) throw healthThrows
    },
    runChatCompletion: async (_port, body) => {
      bodies.push(body)
      const sec = perCallSec[nextSampleIndex]
      nextSampleIndex += 1
      return sec
    },
    now: () => 1_700_000_000_000,
  }
  return {
    runtime,
    startedWith,
    get stops() {
      return stops
    },
    bodies,
  }
}

describe('runBenchmark', () => {
  beforeEach(() => {
    __resetBenchmarkRuntime()
    setCurrentAiHardwareIdentity(TEST_HARDWARE_IDENTITY)
  })
  afterEach(() => {
    __resetBenchmarkRuntime()
    clearCurrentAiHardwareIdentity()
  })

  test('hung production health fetch expires and frees the owned engine (#386)', async () => {
    vi.useFakeTimers()
    const env = makeFakeRuntime({ perCallSec: [1, 1, 1, 1] })
    env.runtime.waitForHealthy = waitForBenchmarkHealthy
    __setBenchmarkRuntime(env.runtime)
    let healthSignal: AbortSignal | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn((_input: unknown, init?: RequestInit) => {
        healthSignal = init?.signal ?? undefined
        return new Promise<Response>(() => {})
      })
    )
    try {
      const pending = runBenchmark(SUPPORTED_MODELS[1], {
        modelPath: '/m.gguf',
        mmprojPath: '/p.gguf',
      })
      const rejected = expect(pending).rejects.toThrow(
        '/health did not return 2xx within 90000 ms'
      )
      await vi.advanceTimersByTimeAsync(90_000)
      await rejected
      expect(healthSignal?.aborted).toBe(true)
      expect(env.stops).toBe(1)
      expect(env.bodies).toHaveLength(0)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.unstubAllGlobals()
      vi.useRealTimers()
    }
  })

  test('readiness cancellation aborts transport and releases its timer (#386)', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    let healthSignal: AbortSignal | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn((_input: unknown, init?: RequestInit) => {
        healthSignal = init?.signal ?? undefined
        return new Promise<Response>(() => {})
      })
    )
    try {
      const pending = waitForBenchmarkHealthy(31337, 90_000, controller.signal)
      const rejected = expect(pending).rejects.toMatchObject({
        name: 'AbortError',
      })
      controller.abort()
      await rejected
      expect(healthSignal?.aborted).toBe(true)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.unstubAllGlobals()
      vi.useRealTimers()
    }
  })

  test.each(['start-race', 'readiness', 'sample'])(
    'default runtime rejects foreign engine replacement during %s (#385)',
    async (stage) => {
      const originalStop = useSidecarStore.getState().stop
      useSidecarStore.setState({
        status: 'idle',
        port: null,
        model: null,
        mmproj: null,
        ctxSize: null,
        pollHandle: null,
        hardwareIdentity: null,
      })
      useSettingsStore.setState((s) => ({
        values: { ...s.values, aiFeaturesEnabled: false },
      }))
      let nextPort = 8000
      let stops = 0
      const runtime: SidecarRuntime = {
        start: async () => ({
          port: nextPort++,
          hardwareIdentity: TEST_HARDWARE_IDENTITY,
        }),
        stop: async () => {
          stops++
        },
        status: async () => {
          throw new Error('unused')
        },
        fetchHealth: async () => true,
        setInterval: () => 99,
        clearInterval: () => {},
        getAiFeaturesEnabled: () => false,
        getEngineAutoInstall: () => true,
      }
      __setSidecarRuntime(runtime)
      const replace = async () => {
        await originalStop()
        await useSidecarStore.getState().start({
          modelPath: '/foreign.gguf',
          mmprojPath: '/foreign-mmproj.gguf',
          purpose: 'benchmark',
        })
      }
      const production = getBenchmarkRuntime()
      const images = makeFakeRuntime({ perCallSec: [] }).runtime.prepareImages
      let completions = 0
      if (stage === 'start-race') {
        useSidecarStore.setState({
          stop: async () => {
            await originalStop()
            await useSidecarStore
              .getState()
              .start({ modelPath: '/foreign.gguf', purpose: 'benchmark' })
          },
        })
      }
      __setBenchmarkRuntime({
        ...production,
        prepareImages: images,
        waitForHealthy: async () => {
          if (stage === 'readiness') await replace()
        },
        runChatCompletion: async () => {
          completions++
          if (stage === 'sample' && completions === 2) await replace()
          return 1
        },
      })
      try {
        await expect(
          runBenchmark(SUPPORTED_MODELS[1], {
            modelPath: '/requested.gguf',
            mmprojPath: '/requested-mmproj.gguf',
          })
        ).rejects.toThrow('engine changed')
        expect(useSidecarStore.getState().status).toBe('running')
        expect(useSidecarStore.getState().model).toBe('/foreign.gguf')
        expect(stops).toBe(stage === 'start-race' ? 1 : 2)
        if (stage !== 'sample') expect(completions).toBe(0)
        expect(useBenchmarkActivity.getState().modelId).toBeNull()
      } finally {
        useSidecarStore.setState({ stop: originalStop })
        await originalStop()
        __resetSidecarRuntime()
      }
    }
  )

  test('one benchmark owns preparation, inference and delayed cleanup across callers (#385)', async () => {
    const env = makeFakeRuntime({ perCallSec: [1, 2, 3, 4, 1, 2, 3, 4] })
    let releaseHealth!: () => void
    let releaseStop!: () => void
    env.runtime.waitForHealthy = () =>
      new Promise((resolve) => {
        releaseHealth = resolve
      })
    const stop = env.runtime.stopSidecar
    env.runtime.stopSidecar = async () => {
      await new Promise<void>((resolve) => {
        releaseStop = resolve
      })
      await stop()
    }
    __setBenchmarkRuntime(env.runtime)
    const first = runBenchmark(SUPPORTED_MODELS[1], {
      modelPath: '/first.gguf',
      mmprojPath: '/first-mmproj.gguf',
    })
    await vi.waitFor(() => expect(env.startedWith).toHaveLength(1))
    expect(useBenchmarkActivity.getState().modelId).toBe(SUPPORTED_MODELS[1].id)
    await expect(
      runBenchmark(SUPPORTED_MODELS[2], {
        modelPath: '/second.gguf',
        mmprojPath: '/second-mmproj.gguf',
      })
    ).rejects.toThrow('Another model benchmark is running')
    expect(env.startedWith).toHaveLength(1)
    releaseHealth()
    await vi.waitFor(() => expect(releaseStop).toBeTypeOf('function'))
    await expect(
      runBenchmark(SUPPORTED_MODELS[2], {
        modelPath: '/second.gguf',
        mmprojPath: '/second-mmproj.gguf',
      })
    ).rejects.toThrow('Another model benchmark is running')
    expect(env.stops).toBe(0)
    releaseStop()
    const result = await first
    expect(result.hardwareIdentity).toEqual(TEST_HARDWARE_IDENTITY)
    expect(env.startedWith[0].modelPath).toBe('/first.gguf')
    expect(env.stops).toBe(1)
    expect(useBenchmarkActivity.getState().modelId).toBeNull()
    env.runtime.waitForHealthy = async () => {}
    env.runtime.stopSidecar = stop
    await runBenchmark(SUPPORTED_MODELS[2], {
      modelPath: '/second.gguf',
      mmprojPath: '/second-mmproj.gguf',
    })
    expect(env.stops).toBe(2)
    expect(env.startedWith[1].modelPath).toBe('/second.gguf')
  })

  test('discards the cold-start warmup sample and stops the sidecar', async () => {
    // First value is the cold-start warmup (must NOT pollute p95); the
    // next 3 are the measured samples.
    const env = makeFakeRuntime({ perCallSec: [90, 3, 5, 8] })
    __setBenchmarkRuntime(env.runtime)
    const spec = SUPPORTED_MODELS[1]
    const events: BenchmarkProgress[] = []
    const result = await runBenchmark(spec, {
      modelPath: '/m.gguf',
      mmprojPath: '/p.gguf',
      onProgress: (e) => events.push(e),
    })
    // Warmup (90) is excluded — p95 reflects steady state, not model load.
    expect(result.samplesSec).toEqual([3, 5, 8])
    expect(result.p50Sec).toBe(5)
    expect(result.p95Sec).toBe(8)
    expect(result.sampleIntervalSec).toBe(9) // ceil(8 + 1), not ceil(90 + 1)
    expect(env.startedWith).toHaveLength(1)
    expect(env.startedWith[0].modelPath).toBe('/m.gguf')
    expect(env.startedWith[0].mmprojPath).toBe('/p.gguf')
    // Stop fires unconditionally to free RAM after benchmark
    expect(env.stops).toBe(1)
    // Warmup + 3 measured requests, each carrying the shared focus shape.
    expect(env.bodies).toHaveLength(4)
    // #171 — the static benchmark images must never hit llama-server's prompt
    // cache. Otherwise only the discarded warmup encodes them and the measured
    // passes can understate a Windows CPU request by roughly 10×.
    expect(
      env.bodies.every((candidate) => candidate.cache_prompt === false)
    ).toBe(true)
    // Cache policy is the only difference; the semantic focus workload stays
    // identical across passes and to the shared live-request builder.
    const semanticBodies = env.bodies.map((candidate) => {
      const focusRequest: Partial<ChatCompletionRequest> = { ...candidate }
      delete focusRequest.cache_prompt
      return JSON.stringify(focusRequest)
    })
    expect(new Set(semanticBodies).size).toBe(1)
    // A1 — the benchmark request must be shape-identical to the live tick:
    // system prompt + a user turn with one text block and TWO image blocks,
    // grammar-constrained 200-token decode. This is what makes the measured
    // p95 (→ sampleIntervalSec) a sustainable cadence. `cache_prompt: false`
    // is the only intentional transport-level addition.
    const body = env.bodies[0]
    expect(body.messages[0]).toMatchObject({ role: 'system' })
    expect(body.messages[1].role).toBe('user')
    expect(body.max_tokens).toBe(200)
    expect(body.temperature).toBe(0)
    expect(body.response_format.type).toBe('json_object')
    const userContent = body.messages[1].content
    expect(Array.isArray(userContent)).toBe(true)
    if (Array.isArray(userContent)) {
      expect(userContent[0]).toMatchObject({ type: 'text' })
      const imageBlocks = userContent.filter((b) => b.type === 'image_url')
      expect(imageBlocks).toHaveLength(2)
      const urls = imageBlocks.flatMap((b) =>
        b.type === 'image_url' ? [b.image_url.url] : []
      )
      // Both slots are JPEG (matching the live tick), and they carry distinct
      // content — a 384 face frame and a 1024-wide screen frame, not the same
      // image twice (NEW-FINDING-2: the screen slot's larger area is what a
      // dynamic-resolution ViT actually pays for, so the benchmark must send
      // it to measure a representative p95).
      for (const url of urls) {
        expect(url).toMatch(/^data:image\/jpeg;base64,/)
      }
      expect(urls[0]).toBe('data:image/jpeg;base64,FACE')
      expect(urls[1]).toBe('data:image/jpeg;base64,SCREEN')
    }
    // Progress timeline: load-image, starting-sidecar, warmup, 3 samples, done
    const phases = events.map((e) => e.phase)
    expect(phases[0]).toBe('loading-image')
    expect(phases[1]).toBe('starting-sidecar')
    expect(phases[2]).toBe('warmup')
    expect(phases.slice(3, 6)).toEqual(['sample', 'sample', 'sample'])
    expect(phases[6]).toBe('done')
  })

  test('still stops the sidecar when a chat completion errors mid-flight', async () => {
    const env = makeFakeRuntime({ perCallSec: [3, NaN, 8] })
    // Replace the second runChatCompletion call with a thrown error.
    let i = 0
    const wrapped: BenchmarkRuntime = {
      ...env.runtime,
      runChatCompletion: async (port, body) => {
        if (i === 1) {
          i += 1
          throw new Error('mid-flight failure')
        }
        i += 1
        return env.runtime.runChatCompletion(port, body)
      },
    }
    __setBenchmarkRuntime(wrapped)
    await expect(
      runBenchmark(SUPPORTED_MODELS[1], {
        modelPath: '/m.gguf',
        mmprojPath: '/p.gguf',
      })
    ).rejects.toThrow('mid-flight failure')
    expect(env.stops).toBe(1)
  })

  test('rejects fast when the sidecar fails to start', async () => {
    const env = makeFakeRuntime({
      perCallSec: [],
      startThrows: new Error('child already running'),
    })
    __setBenchmarkRuntime(env.runtime)
    await expect(
      runBenchmark(SUPPORTED_MODELS[2], {
        modelPath: '/m.gguf',
        mmprojPath: '/p.gguf',
      })
    ).rejects.toThrow('child already running')
    // No samples, but stop is still called via the finally block.
    expect(env.stops).toBe(1)
    expect(env.bodies).toHaveLength(0)
  })
})

// A persisted benchmark from a different engine/protocol (or predating the
// stamp entirely) must read as stale so the picker and sample loop do not
// present or trust incompatible timing numbers.
describe('benchmark fingerprint staleness', () => {
  beforeEach(() => {
    setCurrentAiHardwareIdentity(TEST_HARDWARE_IDENTITY)
  })

  afterEach(() => {
    clearCurrentAiHardwareIdentity()
  })

  test('summariseBenchmark stamps the native sidecar hardware identity', () => {
    const result = summariseBenchmark({
      samplesSec: [3, 5, 8],
      completedAtSec: 1_700_000_000,
      hardwareIdentity: TEST_HARDWARE_IDENTITY,
    })
    expect(result.hardwareIdentity).toEqual(TEST_HARDWARE_IDENTITY)
    expect(result.engineFingerprint).toBe(
      inferenceEngineFingerprintFor(TEST_HARDWARE_IDENTITY)
    )
    expect(isBenchmarkStale(result)).toBe(false)
  })

  test('keeps a benchmark current when persisted identity object keys differ in order', () => {
    const nativeIdentity: AiHardwareIdentity = {
      selection: 'device:Vulkan0',
      topology: [{ id: 'Vulkan0', label: 'NVIDIA RTX 4080' }],
    }
    const persistedIdentity: AiHardwareIdentity = {
      topology: [{ label: 'NVIDIA RTX 4080', id: 'Vulkan0' }],
      selection: 'device:Vulkan0',
    }
    const result = summariseBenchmark({
      samplesSec: [3],
      completedAtSec: 1_700_000_000,
      hardwareIdentity: persistedIdentity,
    })

    expect(JSON.stringify(persistedIdentity)).not.toBe(
      JSON.stringify(nativeIdentity)
    )
    expect(aiHardwareIdentitiesEqual(persistedIdentity, nativeIdentity)).toBe(
      true
    )
    setCurrentAiHardwareIdentity(nativeIdentity)
    expect(isBenchmarkStale(result)).toBe(false)
  })

  test('invalidates timings measured with the historical RAM cache policy', () => {
    const result = summariseBenchmark({
      samplesSec: [3, 5, 8],
      completedAtSec: 1_700_000_000,
      hardwareIdentity: TEST_HARDWARE_IDENTITY,
    })

    expect(
      isBenchmarkStale({
        ...result,
        engineFingerprint:
          'b9095-linuxvulkan1-hwidentity2-cachecold2-device-Vulkan0-Vulkan0=NVIDIA%20RTX%204080',
      })
    ).toBe(true)
    expect(isBenchmarkStale(result)).toBe(false)
  })

  test('a record without a resolved native identity is stale', () => {
    const result = summariseBenchmark({
      samplesSec: [3],
      completedAtSec: 1_700_000_000,
      hardwareIdentity: TEST_HARDWARE_IDENTITY,
    })
    expect(isBenchmarkStale({ ...result, engineFingerprint: undefined })).toBe(
      true
    )
    expect(isBenchmarkStale({ ...result, hardwareIdentity: undefined })).toBe(
      true
    )
    expect(
      isBenchmarkStale({ ...result, engineFingerprint: 'b8000-ngl0' })
    ).toBe(true)
    // #171's prompt-cache-contaminated protocol used this fingerprint.
    expect(
      isBenchmarkStale({ ...result, engineFingerprint: 'b9095-ngl99' })
    ).toBe(true)
  })

  test('invalidates Auto after an eGPU or device-order topology change', () => {
    const auto: AiHardwareIdentity = {
      selection: 'auto',
      topology: [{ id: 'Vulkan0', label: 'Integrated GPU' }],
    }
    const result = summariseBenchmark({
      samplesSec: [3],
      completedAtSec: 1_700_000_000,
      hardwareIdentity: auto,
    })
    setCurrentAiHardwareIdentity(auto)
    expect(isBenchmarkStale(result)).toBe(false)

    setCurrentAiHardwareIdentity({
      selection: 'auto',
      topology: [
        { id: 'Vulkan0', label: 'eGPU' },
        { id: 'Vulkan1', label: 'Integrated GPU' },
      ],
    })
    expect(isBenchmarkStale(result)).toBe(true)
  })

  test('invalidates an explicit ordinal when it resolves to different hardware', () => {
    const explicit: AiHardwareIdentity = {
      selection: 'device:Vulkan1',
      topology: [{ id: 'Vulkan1', label: 'AMD Radeon RX 7800 XT' }],
    }
    const result = summariseBenchmark({
      samplesSec: [3],
      completedAtSec: 1_700_000_000,
      hardwareIdentity: explicit,
    })
    setCurrentAiHardwareIdentity({
      selection: 'device:Vulkan1',
      topology: [{ id: 'Vulkan1', label: 'NVIDIA RTX 4080 eGPU' }],
    })
    expect(isBenchmarkStale(result)).toBe(true)
  })
})
