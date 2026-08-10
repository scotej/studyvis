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
    const deliver = vi.fn(async () => ({ acked: true }))
    const mgr = createInviteRetryManager()

    mgr.register(FRIEND, SESSION, deliver)
    expect(mgr.pendingCount()).toBe(1)

    await mgr.onPresenceOnline(FRIEND)
    expect(deliver).toHaveBeenCalledTimes(1)
    // Delivered → dropped from pending so a later flip can't re-send.
    expect(mgr.pendingCount()).toBe(0)
  })

  test('keeps an unacknowledged transport send pending until a verified ACK arrives', async () => {
    const deliver = vi
      .fn<(signal: AbortSignal) => Promise<{ acked: boolean }>>()
      .mockResolvedValueOnce({ acked: false })
      .mockResolvedValueOnce({ acked: true })
    const mgr = createInviteRetryManager()
    mgr.register(FRIEND, SESSION, deliver)

    await mgr.onPresenceOnline(FRIEND)
    expect(deliver).toHaveBeenCalledTimes(1)
    // A peer on the inbox topic can receive the action but cannot prove it is
    // the intended recipient. Keep this entry retryable without an ACK.
    expect(mgr.pendingCount()).toBe(1)

    await mgr.onPresenceOnline(FRIEND)
    expect(deliver).toHaveBeenCalledTimes(2)
    expect(mgr.pendingCount()).toBe(0)
  })

  test('PR-9: does not deliver a retry for a session that is no longer live', async () => {
    const deliver = vi.fn(async () => ({ acked: true }))
    let live = true
    const mgr = createInviteRetryManager({
      isSessionLive: (topic) => live && topic === SESSION,
    })
    mgr.register(FRIEND, SESSION, deliver)
    expect(mgr.pendingCount()).toBe(1)

    // Host left the session before the friend came back online.
    live = false
    await mgr.onPresenceOnline(FRIEND)
    expect(deliver).not.toHaveBeenCalled()
    // The dead entry is dropped, not left dangling.
    expect(mgr.pendingCount()).toBe(0)
  })

  test('PR-9: still delivers while the session is live', async () => {
    const deliver = vi.fn(async () => ({ acked: true }))
    const mgr = createInviteRetryManager({
      isSessionLive: (topic) => topic === SESSION,
    })
    mgr.register(FRIEND, SESSION, deliver)
    await mgr.onPresenceOnline(FRIEND)
    expect(deliver).toHaveBeenCalledTimes(1)
  })

  test('a different friend coming online does not trigger the retry', async () => {
    const deliver = vi.fn(async () => ({ acked: true }))
    const mgr = createInviteRetryManager()
    mgr.register(FRIEND, SESSION, deliver)

    await mgr.onPresenceOnline(OTHER)
    expect(deliver).not.toHaveBeenCalled()
    expect(mgr.pendingCount()).toBe(1)
  })

  test('never delivers the same (friend, session) twice', async () => {
    const deliver = vi.fn(async () => ({ acked: true }))
    const mgr = createInviteRetryManager()
    mgr.register(FRIEND, SESSION, deliver)

    await mgr.onPresenceOnline(FRIEND)
    // Friend flickers offline→online again: must NOT re-send.
    await mgr.onPresenceOnline(FRIEND)
    expect(deliver).toHaveBeenCalledTimes(1)
  })

  test('markDelivered blocks a subsequent register + retry for that pair', async () => {
    const deliver = vi.fn(async () => ({ acked: true }))
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
    const deliverA = vi.fn(async () => ({ acked: true }))
    const deliverB = vi.fn(async () => ({ acked: true }))
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
    const deliver = vi.fn(async () => ({ acked: true }))
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
    const deliver = vi.fn(async () => ({ acked: true }))
    const mgr = createInviteRetryManager({ now: () => now })
    mgr.register(FRIEND, SESSION, deliver)

    now += RETRY_WINDOW_MS - 1
    await mgr.onPresenceOnline(FRIEND)
    expect(deliver).toHaveBeenCalledTimes(1)
  })

  test('a failed retry stays pending and re-attempts on the next flip', async () => {
    const onRetryError = vi.fn()
    const deliver = vi
      .fn<(signal: AbortSignal) => Promise<{ acked: boolean }>>()
      .mockRejectedValueOnce(new Error('still offline'))
      .mockResolvedValueOnce({ acked: true })
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
    const deliver = vi.fn(async () => ({ acked: true }))
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

  test('cancelAll clears completed-delivery dedupe at the end of a session lifecycle', async () => {
    const deliver = vi.fn(async () => ({ acked: true }))
    const mgr = createInviteRetryManager()

    mgr.markDelivered(FRIEND, SESSION)
    mgr.cancelAll()
    mgr.register(FRIEND, SESSION, deliver)

    expect(mgr.pendingCount()).toBe(1)
    await mgr.onPresenceOnline(FRIEND)
    expect(deliver).toHaveBeenCalledTimes(1)
  })

  test('cancelAll aborts and invalidates an in-flight retry', async () => {
    const onRetryError = vi.fn()
    const observed = { signal: null as AbortSignal | null }
    const deliver = vi.fn(
      (signal: AbortSignal) =>
        new Promise<{ acked: boolean }>((_resolve, reject) => {
          observed.signal = signal
          signal.addEventListener(
            'abort',
            () => reject(new Error('delivery aborted')),
            { once: true }
          )
        })
    )
    const mgr = createInviteRetryManager({ onRetryError })
    mgr.register(FRIEND, SESSION, deliver)

    const inFlight = mgr.onPresenceOnline(FRIEND)
    expect(deliver).toHaveBeenCalledTimes(1)
    expect(observed.signal?.aborted).toBe(false)

    mgr.cancelAll()
    expect(observed.signal?.aborted).toBe(true)
    await inFlight
    expect(mgr.pendingCount()).toBe(0)
    // Cancellation is normal lifecycle cleanup, not a retry failure.
    expect(onRetryError).not.toHaveBeenCalled()

    // A late/aborted old operation must not write the delivered-set and block
    // a genuinely new retry for the same pair.
    const freshDeliver = vi.fn(async () => ({ acked: true }))
    mgr.register(FRIEND, SESSION, freshDeliver)
    expect(mgr.pendingCount()).toBe(1)
  })

  test('a late non-abortable retry completion cannot suppress a new invite', async () => {
    let resolveDelivery!: (result: { acked: boolean }) => void
    const deliver = vi.fn(
      () =>
        new Promise<{ acked: boolean }>((resolve) => {
          resolveDelivery = resolve
        })
    )
    const mgr = createInviteRetryManager()
    mgr.register(FRIEND, SESSION, deliver)

    const inFlight = mgr.onPresenceOnline(FRIEND)
    mgr.cancelAll()
    // This simulates a lower-level transport that cannot honour AbortSignal
    // once its send has started. Its eventual ACK must be ignored.
    resolveDelivery({ acked: true })
    await inFlight

    mgr.register(
      FRIEND,
      SESSION,
      vi.fn(async () => ({ acked: true }))
    )
    expect(mgr.pendingCount()).toBe(1)
  })

  test('cancel removes only the named friend', () => {
    const deliver = vi.fn(async () => ({ acked: true }))
    const mgr = createInviteRetryManager()
    mgr.register(FRIEND, 'session-A', deliver)
    mgr.register(OTHER, 'session-B', deliver)

    mgr.cancel(FRIEND)
    expect(mgr.pendingCount()).toBe(1)
  })
})
