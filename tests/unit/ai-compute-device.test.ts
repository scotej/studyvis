import { afterEach, describe, expect, test } from 'vitest'

import {
  clearCurrentAiHardwareIdentity,
  computeDeviceFingerprint,
  computeDeviceId,
  currentAiHardwareIdentity,
  inferenceEngineFingerprintFor,
  isAiComputeDeviceSelection,
  persistAiComputeDeviceSelection,
  readCachedAiComputeDeviceSelection,
  setCurrentAiHardwareIdentity,
} from '@/features/ai'

afterEach(() => {
  clearCurrentAiHardwareIdentity()
})

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
    expect(
      inferenceEngineFingerprintFor({ selection: 'auto', topology: [] })
    ).not.toBe(
      inferenceEngineFingerprintFor({ selection: 'cpu', topology: [] })
    )
    expect(
      inferenceEngineFingerprintFor({
        selection: 'device:Vulkan0',
        topology: [{ id: 'Vulkan0', label: 'GPU A' }],
      })
    ).not.toBe(
      inferenceEngineFingerprintFor({
        selection: 'device:Vulkan1',
        topology: [{ id: 'Vulkan1', label: 'GPU B' }],
      })
    )
  })

  test('node environments safely default to automatic hardware', () => {
    expect(readCachedAiComputeDeviceSelection()).toBe('auto')
  })

  test('a late native identity for the old choice cannot win a newer canonical write', async () => {
    setCurrentAiHardwareIdentity({
      selection: 'auto',
      topology: [{ id: 'Vulkan0', label: 'Integrated GPU' }],
    })
    await persistAiComputeDeviceSelection('device:Vulkan1')

    // Simulates an engine_info request started before the click completing
    // after it. The canonical-write expectation rejects this stale response.
    setCurrentAiHardwareIdentity({
      selection: 'auto',
      topology: [{ id: 'Vulkan0', label: 'Integrated GPU' }],
    })
    expect(currentAiHardwareIdentity()).toBeNull()

    setCurrentAiHardwareIdentity({
      selection: 'device:Vulkan1',
      topology: [{ id: 'Vulkan1', label: 'eGPU' }],
    })
    expect(currentAiHardwareIdentity()).toEqual({
      selection: 'device:Vulkan1',
      topology: [{ id: 'Vulkan1', label: 'eGPU' }],
    })
  })
})
