import { afterEach, expect, test, vi } from 'vitest'

import {
  __resetEngineRuntime,
  __setEngineRuntime,
  ENGINE_INFO_TIMEOUT_MS,
  getAiPlatformSupported,
  isAiPlatformSupportPending,
  readEngineInfo,
  type EngineInfo,
} from '@/features/ai/engine'

const info = (supported: boolean): EngineInfo => ({
  supported,
  installed: true,
  source: 'bundled',
  version: 'fixture',
  installing: false,
  last_error: null,
  devices: [],
  device_error: null,
  hardware_identity: { selection: 'auto', topology: [] },
})

function setInfo(read: () => Promise<EngineInfo>) {
  __setEngineRuntime({
    info: read,
    install: async () => {},
    subscribeProgress: async () => () => {},
  })
}

afterEach(() => {
  __resetEngineRuntime()
  vi.useRealTimers()
})

test('pending support is shared and cannot authorize AI', async () => {
  let settle!: (value: EngineInfo) => void
  const read = vi.fn(
    () =>
      new Promise<EngineInfo>((resolve) => {
        settle = resolve
      })
  )
  setInfo(read)
  const first = readEngineInfo()
  expect(readEngineInfo()).toBe(first)
  expect(getAiPlatformSupported()).toBe(false)
  expect(isAiPlatformSupportPending()).toBe(true)
  await Promise.resolve()
  settle(info(true))
  await first
  expect(read).toHaveBeenCalledTimes(1)
  expect(getAiPlatformSupported()).toBe(true)
  expect(isAiPlatformSupportPending()).toBe(false)
})

test('an obsolete supported response cannot authorize a replacement runtime', async () => {
  let settle!: (value: EngineInfo) => void
  setInfo(
    () =>
      new Promise((resolve) => {
        settle = resolve
      })
  )
  const stale = readEngineInfo()
  await Promise.resolve()
  setInfo(async () => info(false))
  await readEngineInfo()
  settle(info(true))
  await stale
  expect(getAiPlatformSupported()).toBe(false)
  expect(isAiPlatformSupportPending()).toBe(false)
})

test('a failed support lookup stops pending state and allows ordinary study', async () => {
  setInfo(async () => {
    throw new Error('IPC failed')
  })
  await expect(readEngineInfo()).rejects.toThrow('IPC failed')
  expect(getAiPlatformSupported()).toBe(false)
  expect(isAiPlatformSupportPending()).toBe(false)
})

test('a hung lookup is bounded; its late support response cannot enable AI', async () => {
  vi.useFakeTimers()
  let settle!: (value: EngineInfo) => void
  setInfo(
    () =>
      new Promise((resolve) => {
        settle = resolve
      })
  )
  const result = expect(readEngineInfo()).rejects.toThrow('engine_info_timeout')
  await vi.advanceTimersByTimeAsync(ENGINE_INFO_TIMEOUT_MS)
  await result
  expect(isAiPlatformSupportPending()).toBe(false)
  settle(info(true))
  await Promise.resolve()
  await Promise.resolve()
  expect(getAiPlatformSupported()).toBe(false)
})
