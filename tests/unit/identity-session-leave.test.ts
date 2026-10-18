import { afterEach, expect, test, vi } from 'vitest'
import { leaveForIdentityRecovery } from '@/features/settings/leaveForIdentityRecovery'
import { useSessionStore } from '@/stores/sessionStore'

afterEach(() => useSessionStore.getState().reset())

test('identity settings awaits the ordinary session leave/persistence handler', async () => {
  let finish!: () => void
  const persisted = new Promise<void>((resolve) => (finish = resolve))
  const leave = vi.fn(async () => {
    await persisted
    useSessionStore.getState().markEnded()
  })
  useSessionStore.getState().begin({
    sessionTopic: 'topic',
    sessionPassword: 'password',
    isHost: true,
    startedAt: 1,
    room: {} as never,
    leave,
  })
  const leaving = leaveForIdentityRecovery()
  expect(leave).toHaveBeenCalledOnce()
  expect(useSessionStore.getState().pendingEndReason).toBe('user')
  expect(useSessionStore.getState().status).toBe('active')
  finish()
  await leaving
  expect(useSessionStore.getState().status).toBe('ended')
})

test('a failed leave keeps the session active and makes the ordinary path retryable', async () => {
  const leave = vi.fn(async () => {
    throw new Error('persistence unavailable')
  })
  useSessionStore.getState().begin({
    sessionTopic: 'topic',
    sessionPassword: 'password',
    isHost: true,
    startedAt: 1,
    room: {} as never,
    leave,
  })
  await expect(leaveForIdentityRecovery()).rejects.toThrow(
    'persistence unavailable'
  )
  expect(useSessionStore.getState().status).toBe('active')
  expect(useSessionStore.getState().pendingEndReason).toBeNull()
  await expect(leaveForIdentityRecovery()).rejects.toThrow()
  expect(leave).toHaveBeenCalledTimes(2)
})
