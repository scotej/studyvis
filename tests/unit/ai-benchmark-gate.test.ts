import { describe, expect, test } from 'vitest'

import {
  getAiEnableReadiness,
  summariseBenchmark,
  type ModelRecord,
} from '@/features/ai'

function record(
  modelId: string,
  benchmark: ModelRecord['benchmark'] = null
): ModelRecord {
  return {
    modelId,
    benchmark,
    installedAt: 100,
  }
}

describe('getAiEnableReadiness', () => {
  test.each([
    ['loading', 'loading'],
    ['error', 'error'],
  ] as const)('maps the %s store status directly', (status, expected) => {
    expect(
      getAiEnableReadiness({
        status,
        activeModelId: 'moondream2',
        records: {},
      })
    ).toBe(expected)
  })

  test('requires a selected model once the store is ready', () => {
    expect(
      getAiEnableReadiness({
        status: 'ready',
        activeModelId: null,
        records: { moondream2: record('moondream2') },
      })
    ).toBe('no-model')
  })

  test('warns when the selected model has not been benchmarked', () => {
    expect(
      getAiEnableReadiness({
        status: 'ready',
        activeModelId: 'moondream2',
        records: { moondream2: record('moondream2') },
      })
    ).toBe('unbenchmarked')
  })

  test('treats a missing selected record as no model', () => {
    expect(
      getAiEnableReadiness({
        status: 'ready',
        activeModelId: 'missing-model',
        records: {},
      })
    ).toBe('no-model')
  })

  test('treats a partial-download record as no model', () => {
    expect(
      getAiEnableReadiness({
        status: 'ready',
        activeModelId: 'moondream2',
        records: {
          moondream2: {
            ...record('moondream2'),
            installedAt: null,
            interruptedDownload: { bytesReceived: 1024, at: 100 },
          },
        },
      })
    ).toBe('no-model')
  })

  test('is ready when the selected model has a benchmark', () => {
    const benchmark = summariseBenchmark({
      samplesSec: [2, 3, 4],
      completedAtSec: 99,
    })

    expect(
      getAiEnableReadiness({
        status: 'ready',
        activeModelId: 'moondream2',
        records: { moondream2: record('moondream2', benchmark) },
      })
    ).toBe('ready')
  })

  test('treats a benchmark from the cache-contaminated protocol as unbenchmarked', () => {
    const benchmark = {
      ...summariseBenchmark({
        samplesSec: [11.303, 12.573, 8.997],
        completedAtSec: 99,
      }),
      engineFingerprint: 'b9095-ngl99',
    }

    expect(
      getAiEnableReadiness({
        status: 'ready',
        activeModelId: 'gemma3-4b',
        records: { 'gemma3-4b': record('gemma3-4b', benchmark) },
      })
    ).toBe('unbenchmarked')
  })
})
