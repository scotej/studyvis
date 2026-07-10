import { afterEach, describe, expect, test, vi } from 'vitest'

import {
  leaveBeforeQuit,
  QUIT_LEAVE_TIMEOUT_MS,
} from '@/features/system/quitLeave'

describe('leaveBeforeQuit (#47 A1)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  test('resolves immediately when no session leave handler exists', async () => {
    await expect(leaveBeforeQuit(null)).resolves.toBeUndefined()
  })

  test('awaits the leave handler so persistence lands before quit', async () => {
    let persisted = false
    await leaveBeforeQuit(async () => {
      persisted = true
    })
    expect(persisted).toBe(true)
  })

  test('a rejecting leave handler still resolves — quit is never blocked', async () => {
    await expect(
      leaveBeforeQuit(() => Promise.reject(new Error('teardown failed')))
    ).resolves.toBeUndefined()
  })

  test('a hung leave handler resolves at the timeout, not before', async () => {
    vi.useFakeTimers()
    let settled = false
    const pending = leaveBeforeQuit(() => new Promise<void>(() => {})).then(
      () => {
        settled = true
      }
    )
    await vi.advanceTimersByTimeAsync(QUIT_LEAVE_TIMEOUT_MS - 1)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await pending
    expect(settled).toBe(true)
  })
})
