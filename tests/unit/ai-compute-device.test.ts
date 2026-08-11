import { afterEach, describe, expect, test, vi } from 'vitest'

import {
  clearCurrentAiHardwareIdentity,
  computeDeviceFingerprint,
  computeDeviceId,
  createAiComputeDeviceSelectionGuard,
  currentAiHardwareIdentity,
  inferenceEngineFingerprintFor,
  isAiComputeDeviceSelection,
  persistAiComputeDeviceSelection,
  readCachedAiComputeDeviceSelection,
  setCurrentAiHardwareIdentity,
} from '@/features/ai'
import {
  __setAiComputeDeviceTestRuntime,
  hydrateAiComputeDeviceSelection,
} from '@/features/ai/computeDevice'

afterEach(() => {
  clearCurrentAiHardwareIdentity()
  __setAiComputeDeviceTestRuntime(null)
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

  test('a delayed canonical get cannot overwrite a newer saved choice or its UI', async () => {
    let resolveStored!: (value: unknown) => void
    const get = vi.fn(
      () =>
        new Promise<unknown>((resolve) => {
          resolveStored = resolve
        })
    )
    const set = vi.fn(async () => undefined)
    const save = vi.fn(async () => undefined)
    __setAiComputeDeviceTestRuntime({
      tauri: true,
      store: { get, set, save } as never,
    })

    // Models AiCategory's render-visible guard as well as the underlying
    // canonical-store race: hydration starts with A, the user saves B, then
    // the delayed get(A) resolves.
    const uiGuard = createAiComputeDeviceSelectionGuard()
    const hydrationOperation = uiGuard.hydrationSnapshot()
    const hydration = hydrateAiComputeDeviceSelection()
    await Promise.resolve()

    const userOperation = uiGuard.markUserChoice()
    let renderedSelection = 'cpu'
    await persistAiComputeDeviceSelection('cpu')
    resolveStored('auto')
    const staleHydratedSelection = await hydration
    if (uiGuard.isCurrent(hydrationOperation)) {
      renderedSelection = staleHydratedSelection
    }

    expect(uiGuard.isCurrent(userOperation)).toBe(true)
    expect(renderedSelection).toBe('cpu')
    expect(set).toHaveBeenCalledWith('selection', 'cpu')
    expect(save).toHaveBeenCalledTimes(1)

    // The late get(A) also must not replace the canonical expectation: an old
    // engine_info identity remains rejected, while the saved CPU identity is
    // accepted.
    setCurrentAiHardwareIdentity({
      selection: 'auto',
      topology: [{ id: 'Vulkan0', label: 'Integrated GPU' }],
    })
    expect(currentAiHardwareIdentity()).toBeNull()
    setCurrentAiHardwareIdentity({ selection: 'cpu', topology: [] })
    expect(currentAiHardwareIdentity()).toEqual({
      selection: 'cpu',
      topology: [],
    })
  })
})
