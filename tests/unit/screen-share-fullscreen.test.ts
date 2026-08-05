import { describe, expect, test, vi } from 'vitest'

import {
  createScreenShareFullscreenController,
  type ScreenShareFullscreenRuntime,
} from '@/lib/screenShareFullscreen'

function runtimeHarness(initiallyActive = false) {
  let active = initiallyActive
  let changeHandler: (() => void) | null = null
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
      return () => {
        changeHandler = null
      }
    }),
  }

  return {
    runtime,
    setActive(next: boolean) {
      active = next
      changeHandler?.()
    },
  }
}

async function flushMicrotasks() {
  await Promise.resolve()
  await Promise.resolve()
}

describe('screen-share fullscreen controller', () => {
  test('enters once and restores the native window on close', async () => {
    const harness = runtimeHarness()
    const onExited = vi.fn()
    const controller = createScreenShareFullscreenController(
      harness.runtime,
      onExited
    )

    await controller.open()
    await controller.open()
    await controller.close()
    await controller.close()

    expect(harness.runtime.enter).toHaveBeenCalledTimes(1)
    expect(harness.runtime.exit).toHaveBeenCalledTimes(1)
    expect(onExited).not.toHaveBeenCalled()
  })

  test('closes the viewer when macOS exits fullscreen externally', async () => {
    const harness = runtimeHarness()
    const onExited = vi.fn()
    const controller = createScreenShareFullscreenController(
      harness.runtime,
      onExited
    )

    await controller.open()
    harness.setActive(false)
    await flushMicrotasks()

    expect(onExited).toHaveBeenCalledTimes(1)
    await controller.close()
  })

  test('ignores transient fullscreen-state query failures', async () => {
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
    await controller.close()
  })
})
