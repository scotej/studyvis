import { describe, expect, test, vi } from 'vitest'

import {
  createInviteRetryManager,
  RETRY_WINDOW_MS,
} from '@/features/friends/inviteRetry'

const FRIEND = 'aa'.repeat(32)
const OTHER = 'bb'.repeat(32)
const SESSION = 'session-topic-1'

describe('createInviteRetryManager', () => {
  test('retries a queued invite when the friend comes online', async () => {
    const deliver = vi.fn(async () => {})
    const mgr = createInviteRetryManager()

    mgr.register(FRIEND, SESSION, deliver)
    expect(mgr.pendingCount()).toBe(1)

    await mgr.onPresenceOnline(FRIEND)
    expect(deliver).toHaveBeenCalledTimes(1)
    // Delivered → dropped from pending so a later flip can't re-send.
    expect(mgr.pendingCount()).toBe(0)
  })

  test('a different friend coming online does not trigger the retry', async () => {
    const deliver = vi.fn(async () => {})
    const mgr = createInviteRetryManager()
    mgr.register(FRIEND, SESSION, deliver)

    await mgr.onPresenceOnline(OTHER)
    expect(deliver).not.toHaveBeenCalled()
    expect(mgr.pendingCount()).toBe(1)
  })

  test('never delivers the same (friend, session) twice', async () => {
    const deliver = vi.fn(async () => {})
    const mgr = createInviteRetryManager()
    mgr.register(FRIEND, SESSION, deliver)

    await mgr.onPresenceOnline(FRIEND)
    // Friend flickers offline→online again: must NOT re-send.
    await mgr.onPresenceOnline(FRIEND)
    expect(deliver).toHaveBeenCalledTimes(1)
  })

  test('markDelivered blocks a subsequent register + retry for that pair', async () => {
    const deliver = vi.fn(async () => {})
    const mgr = createInviteRetryManager()

    // The first send succeeded directly (no timeout), so it was marked
    // delivered without ever registering a pending entry.
    mgr.markDelivered(FRIEND, SESSION)
    mgr.register(FRIEND, SESSION, deliver)
    expect(mgr.pendingCount()).toBe(0)

    await mgr.onPresenceOnline(FRIEND)
    expect(deliver).not.toHaveBeenCalled()
  })

  test('a distinct session for the same friend is tracked independently', async () => {
    const deliverA = vi.fn(async () => {})
    const deliverB = vi.fn(async () => {})
    const mgr = createInviteRetryManager()
    mgr.register(FRIEND, 'session-A', deliverA)
    mgr.register(FRIEND, 'session-B', deliverB)
    expect(mgr.pendingCount()).toBe(2)

    await mgr.onPresenceOnline(FRIEND)
    expect(deliverA).toHaveBeenCalledTimes(1)
    expect(deliverB).toHaveBeenCalledTimes(1)
  })

  test('expired entries are dropped and never retried', async () => {
    let now = 1_000_000
    const deliver = vi.fn(async () => {})
    const mgr = createInviteRetryManager({ now: () => now })
    mgr.register(FRIEND, SESSION, deliver)

    // Advance past the retry window.
    now += RETRY_WINDOW_MS + 1
    await mgr.onPresenceOnline(FRIEND)
    expect(deliver).not.toHaveBeenCalled()
    expect(mgr.pendingCount()).toBe(0)
  })

  test('a within-window flip still retries', async () => {
    let now = 1_000_000
    const deliver = vi.fn(async () => {})
    const mgr = createInviteRetryManager({ now: () => now })
    mgr.register(FRIEND, SESSION, deliver)

    now += RETRY_WINDOW_MS - 1
    await mgr.onPresenceOnline(FRIEND)
    expect(deliver).toHaveBeenCalledTimes(1)
  })

  test('a failed retry stays pending and re-attempts on the next flip', async () => {
    const onRetryError = vi.fn()
    const deliver = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('still offline'))
      .mockResolvedValueOnce(undefined)
    const mgr = createInviteRetryManager({ onRetryError })
    mgr.register(FRIEND, SESSION, deliver)

    await mgr.onPresenceOnline(FRIEND)
    expect(deliver).toHaveBeenCalledTimes(1)
    expect(onRetryError).toHaveBeenCalledTimes(1)
    // Failed → still pending.
    expect(mgr.pendingCount()).toBe(1)

    await mgr.onPresenceOnline(FRIEND)
    expect(deliver).toHaveBeenCalledTimes(2)
    expect(mgr.pendingCount()).toBe(0)
  })

  test('cancelAll drops every pending entry (session ended / cancelled)', async () => {
    const deliver = vi.fn(async () => {})
    const mgr = createInviteRetryManager()
    mgr.register(FRIEND, 'session-A', deliver)
    mgr.register(OTHER, 'session-B', deliver)
    expect(mgr.pendingCount()).toBe(2)

    mgr.cancelAll()
    expect(mgr.pendingCount()).toBe(0)

    await mgr.onPresenceOnline(FRIEND)
    await mgr.onPresenceOnline(OTHER)
    expect(deliver).not.toHaveBeenCalled()
  })

  test('cancel removes only the named friend', () => {
    const deliver = vi.fn(async () => {})
    const mgr = createInviteRetryManager()
    mgr.register(FRIEND, 'session-A', deliver)
    mgr.register(OTHER, 'session-B', deliver)

    mgr.cancel(FRIEND)
    expect(mgr.pendingCount()).toBe(1)
  })
})
