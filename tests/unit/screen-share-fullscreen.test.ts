import { afterEach, describe, expect, test, vi } from 'vitest'

import {
  createScreenShareFullscreenController,
  type ScreenShareFullscreenRuntime,
} from '@/lib/screenShareFullscreen'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function runtimeHarness(initiallyActive = false) {
  let active = initiallyActive
  let changeHandler: (() => void) | null = null
  const unlisten = vi.fn(() => {
    changeHandler = null
  })
  const runtime: ScreenShareFullscreenRuntime = {
    enter: vi.fn(async () => {
      active = true
    }),
    exit: vi.fn(async () => {
      active = false
    }),
    isActive: vi.fn(async () => active),
    onChange: vi.fn(async (handler) => {
      changeHandler = handler
      return unlisten
    }),
  }

  return {
    runtime,
    unlisten,
    setActive(next: boolean) {
      active = next
      changeHandler?.()
    },
    emitChange() {
      changeHandler?.()
    },
  }
}

async function flushMicrotasks() {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

afterEach(() => {
  vi.useRealTimers()
})

describe('screen-share fullscreen controller', () => {
  test('enters once and restores controller-owned fullscreen on close', async () => {
    const harness = runtimeHarness()
    const onExited = vi.fn()
    const controller = createScreenShareFullscreenController(
      harness.runtime,
      onExited
    )

    await Promise.all([controller.open(), controller.open()])
    await Promise.all([controller.close(), controller.close()])

    expect(harness.runtime.enter).toHaveBeenCalledTimes(1)
    expect(harness.runtime.exit).toHaveBeenCalledTimes(1)
    expect(harness.unlisten).toHaveBeenCalledTimes(1)
    expect(onExited).not.toHaveBeenCalled()
  })

  test('preserves fullscreen that existed before the viewer opened', async () => {
    const harness = runtimeHarness(true)
    const controller = createScreenShareFullscreenController(
      harness.runtime,
      vi.fn()
    )

    await controller.open()
    await controller.close()

    expect(harness.runtime.enter).not.toHaveBeenCalled()
    expect(harness.runtime.exit).not.toHaveBeenCalled()
  })

  test('closes the viewer once when native fullscreen exits externally', async () => {
    const harness = runtimeHarness()
    const onExited = vi.fn()
    const controller = createScreenShareFullscreenController(
      harness.runtime,
      onExited
    )

    await controller.open()
    harness.setActive(false)
    harness.emitChange()
    await flushMicrotasks()

    expect(onExited).toHaveBeenCalledTimes(1)
    await controller.close()
  })

  test('retries a transient fullscreen-state query failure', async () => {
    vi.useFakeTimers()
    const harness = runtimeHarness()
    const onExited = vi.fn()
    const controller = createScreenShareFullscreenController(
      harness.runtime,
      onExited
    )

    await controller.open()
    vi.mocked(harness.runtime.isActive).mockRejectedValueOnce(
      new Error('window transition in progress')
    )
    harness.setActive(false)
    await flushMicrotasks()

    expect(onExited).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(100)

    expect(onExited).toHaveBeenCalledTimes(1)
    await controller.close()
  })

  test('removes a listener that finishes registering after close', async () => {
    const registration = deferred<() => void>()
    const unlisten = vi.fn()
    const runtime: ScreenShareFullscreenRuntime = {
      enter: vi.fn(async () => {}),
      exit: vi.fn(async () => {}),
      isActive: vi.fn(async () => false),
      onChange: vi.fn(() => registration.promise),
    }
    const controller = createScreenShareFullscreenController(runtime, vi.fn())

    const opening = controller.open()
    await flushMicrotasks()
    const closing = controller.close()
    registration.resolve(unlisten)
    await Promise.all([opening, closing])

    expect(unlisten).toHaveBeenCalledTimes(1)
    expect(runtime.enter).not.toHaveBeenCalled()
    expect(runtime.exit).not.toHaveBeenCalled()
  })

  test('restores fullscreen when close races an in-flight enter', async () => {
    const entering = deferred<void>()
    const harness = runtimeHarness()
    vi.mocked(harness.runtime.enter).mockImplementation(() => entering.promise)
    const controller = createScreenShareFullscreenController(
      harness.runtime,
      vi.fn()
    )

    const opening = controller.open()
    await flushMicrotasks()
    const closing = controller.close()
    entering.resolve()
    await Promise.all([opening, closing])

    expect(harness.runtime.exit).toHaveBeenCalledTimes(1)
    expect(harness.unlisten).toHaveBeenCalledTimes(1)
  })
})
