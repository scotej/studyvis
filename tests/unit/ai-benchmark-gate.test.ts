import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import {
  clearCurrentAiHardwareIdentity,
  getAiEnableReadiness,
  setCurrentAiHardwareIdentity,
  summariseBenchmark,
  type ModelRecord,
} from '@/features/ai'

const HARDWARE_IDENTITY = {
  selection: 'auto' as const,
  topology: [{ id: 'Metal0', label: 'Apple M2' }],
}

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
  beforeEach(() => {
    setCurrentAiHardwareIdentity(HARDWARE_IDENTITY)
  })

  afterEach(() => {
    clearCurrentAiHardwareIdentity()
  })

  test.each([
    ['loading', 'loading'],
    ['error', 'error'],
  ] as const)('maps the %s store status directly', (status, expected) => {
    expect(
      getAiEnableReadiness({
        status,
        activeModelId: 'qwen2_5-vl-3b',
        records: {},
      })
    ).toBe(expected)
  })

  test('a retained unavailable selection is not enable-ready even with a fresh benchmark', () => {
    const benchmark = summariseBenchmark({
      samplesSec: [2, 3, 4],
      completedAtSec: 99,
      hardwareIdentity: HARDWARE_IDENTITY,
    })
    expect(
      getAiEnableReadiness({
        status: 'ready',
        activeModelId: 'moondream2',
        records: { moondream2: record('moondream2', benchmark) },
      })
    ).toBe('unavailable')
  })

  test('requires a selected model once the store is ready', () => {
    expect(
      getAiEnableReadiness({
        status: 'ready',
        activeModelId: null,
        records: { 'qwen2_5-vl-3b': record('qwen2_5-vl-3b') },
      })
    ).toBe('no-model')
  })

  test('warns when the selected model has not been benchmarked', () => {
    expect(
      getAiEnableReadiness({
        status: 'ready',
        activeModelId: 'qwen2_5-vl-3b',
        records: { 'qwen2_5-vl-3b': record('qwen2_5-vl-3b') },
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
        activeModelId: 'qwen2_5-vl-3b',
        records: {
          'qwen2_5-vl-3b': {
            ...record('qwen2_5-vl-3b'),
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
      hardwareIdentity: HARDWARE_IDENTITY,
    })

    expect(
      getAiEnableReadiness({
        status: 'ready',
        activeModelId: 'qwen2_5-vl-3b',
        records: { 'qwen2_5-vl-3b': record('qwen2_5-vl-3b', benchmark) },
      })
    ).toBe('ready')
  })

  test('treats a benchmark from the cache-contaminated protocol as unbenchmarked', () => {
    const benchmark = {
      ...summariseBenchmark({
        samplesSec: [11.303, 12.573, 8.997],
        completedAtSec: 99,
        hardwareIdentity: HARDWARE_IDENTITY,
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
