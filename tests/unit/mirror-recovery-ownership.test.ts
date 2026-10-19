import { afterEach, expect, test, vi } from 'vitest'
import {
  __resetSessionRecoveryDeps,
  __setSessionRecoveryDeps,
  clearSessionRecoveryGuarded,
} from '@/features/session/recovery'

afterEach(__resetSessionRecoveryDeps)
function fixture(
  options: { remove?: () => Promise<boolean>; save?: () => Promise<void> } = {}
) {
  const store = {
    get: vi.fn(async () => undefined),
    set: vi.fn(async () => {}),
    delete: vi.fn(options.remove ?? (async () => true)),
    save: vi.fn(options.save ?? (async () => {})),
  }
  __setSessionRecoveryDeps({
    storeFactory: () => store,
    seal: async () => {
      throw new Error('not called')
    },
    open: async () => {
      throw new Error('not called')
    },
  })
  return store
}
test('stale queued recovery clear never dispatches a store mutation', async () => {
  const store = fixture()
  let current = true
  const result = clearSessionRecoveryGuarded(() => current)
  current = false
  expect(await result).toBe(false)
  expect(store.delete).not.toHaveBeenCalled()
  expect(store.save).not.toHaveBeenCalled()
})
test('owner loss after a dispatched delete prevents the subsequent save', async () => {
  let release!: (result: boolean) => void
  const store = fixture({
    remove: () =>
      new Promise((resolve) => {
        release = resolve
      }),
  })
  let current = true
  const result = clearSessionRecoveryGuarded(() => current)
  await vi.waitFor(() => expect(store.delete).toHaveBeenCalledOnce())
  current = false
  release(true)
  expect(await result).toBe(false)
  expect(store.save).not.toHaveBeenCalled()
})
test('durability failure is local to this operation and cannot become a successful ACK', async () => {
  const store = fixture({
    save: async () => {
      throw new Error('disk full')
    },
  })
  expect(await clearSessionRecoveryGuarded(() => true)).toBe(false)
  store.save.mockResolvedValueOnce(undefined)
  expect(await clearSessionRecoveryGuarded(() => true)).toBe(true)
})
