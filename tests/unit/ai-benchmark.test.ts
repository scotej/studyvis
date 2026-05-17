import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import {
  __resetBenchmarkRuntime,
  __setBenchmarkRuntime,
  runBenchmark,
  SUPPORTED_MODELS,
  type BenchmarkProgress,
  type BenchmarkRuntime,
  type ChatCompletionRequest,
} from '@/features/ai'

function makeFakeRuntime({
  perCallSec,
  startThrows,
  healthThrows,
  loadImageThrows,
}: {
  perCallSec: number[]
  startThrows?: Error
  healthThrows?: Error
  loadImageThrows?: Error
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
    loadBenchmarkImage: async () => {
      if (loadImageThrows) throw loadImageThrows
      return { base64: 'AAAA', mimeType: 'image/png' }
    },
    startSidecar: async (params) => {
      if (startThrows) throw startThrows
      startedWith.push(params)
      return { port: 31337 }
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
  })
  afterEach(() => {
    __resetBenchmarkRuntime()
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
    // Warmup + 3 measured requests, each carrying the data URI
    expect(env.bodies).toHaveLength(4)
    const dataUriBlock = env.bodies[0].messages[0].content
    expect(Array.isArray(dataUriBlock)).toBe(true)
    if (Array.isArray(dataUriBlock)) {
      const imageBlock = dataUriBlock.find((b) => b.type === 'image_url')
      expect(imageBlock).toBeDefined()
      if (imageBlock && imageBlock.type === 'image_url') {
        expect(imageBlock.image_url.url).toMatch(/^data:image\/png;base64,/)
      }
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
      runBenchmark(SUPPORTED_MODELS[0], {
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
