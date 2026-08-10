import { describe, expect, test } from 'vitest'

import {
  computeDeviceFingerprint,
  computeDeviceId,
  inferenceEngineFingerprintFor,
  isAiComputeDeviceSelection,
  readCachedAiComputeDeviceSelection,
} from '@/features/ai'

describe('AI compute device selection', () => {
  test('accepts automatic, CPU, and one explicit llama device', () => {
    expect(isAiComputeDeviceSelection('auto')).toBe(true)
    expect(isAiComputeDeviceSelection('cpu')).toBe(true)
    expect(isAiComputeDeviceSelection('device:Vulkan0')).toBe(true)
    expect(isAiComputeDeviceSelection('device:Metal')).toBe(true)
  })

  test('rejects malformed or multi-device values', () => {
    expect(isAiComputeDeviceSelection('device:')).toBe(false)
    expect(isAiComputeDeviceSelection('device:Vulkan0,Vulkan1')).toBe(false)
    expect(isAiComputeDeviceSelection('device:Vulkan0\n--model')).toBe(false)
    expect(isAiComputeDeviceSelection(`device:${'x'.repeat(129)}`)).toBe(false)
    expect(isAiComputeDeviceSelection('gpu')).toBe(false)
  })

  test('extracts and fingerprints an explicit device without changing its id', () => {
    expect(computeDeviceId('auto')).toBeNull()
    expect(computeDeviceId('cpu')).toBeNull()
    expect(computeDeviceId('device:Vulkan1')).toBe('Vulkan1')
    expect(computeDeviceFingerprint('device:Vulkan1')).toBe('device-Vulkan1')
  })

  test('benchmarks are hardware-qualified', () => {
    expect(inferenceEngineFingerprintFor('auto')).not.toBe(
      inferenceEngineFingerprintFor('cpu')
    )
    expect(inferenceEngineFingerprintFor('device:Vulkan0')).not.toBe(
      inferenceEngineFingerprintFor('device:Vulkan1')
    )
  })

  test('node environments safely default to automatic hardware', () => {
    expect(readCachedAiComputeDeviceSelection()).toBe('auto')
  })
})
