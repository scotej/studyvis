import { describe, expect, test } from 'vitest'

import {
  overlayItemFromToast,
  overlayToastSignature,
  SessionOverlayQueue,
} from '@/features/session/sessionOverlay'

describe('session overlay queue', () => {
  test('preserves the active item when a bounded queue overflows', () => {
    const queue = new SessionOverlayQueue(3)
    queue.enqueue(item('a'), 0)
    queue.enqueue(item('b'), 1)
    queue.enqueue(item('c'), 2)
    queue.enqueue(item('d'), 3)

    expect(queue.snapshot(3)).toMatchObject({ item: { id: 'a' }, queued: 2 })
    expect(queue.dismiss('a', 3)).toMatchObject({ item: { id: 'c' } })
    expect(queue.dismiss('c', 3)).toMatchObject({ item: { id: 'd' } })
  })

  test('refreshes a duplicate in place instead of growing the queue', () => {
    const queue = new SessionOverlayQueue()
    queue.enqueue(item('a'), 0)
    queue.enqueue(item('b'), 1)
    queue.enqueue({ ...item('b'), body: 'updated' }, 5)

    expect(queue.snapshot(5)).toMatchObject({ item: { id: 'a' }, queued: 1 })
    expect(queue.dismiss('a', 5)).toMatchObject({
      item: { id: 'b', body: 'updated', expiresAt: 1_005 },
      queued: 0,
    })
  })

  test('prunes expired entries before exposing the next item', () => {
    const queue = new SessionOverlayQueue()
    queue.enqueue({ ...item('short'), ttlMs: 10 }, 0)
    queue.enqueue(item('long'), 1)

    expect(queue.snapshot(10)).toMatchObject({ item: { id: 'long' } })
    expect(queue.snapshot(1_001)).toEqual({ item: null, queued: 0 })
  })
})

describe('toast mirroring', () => {
  test('maps warning and error to distinct overlay tones', () => {
    expect(
      overlayItemFromToast({ id: 1, title: 'AI is delayed', type: 'warning' })
    ).toMatchObject({ tone: 'warning', body: 'AI is delayed' })
    expect(
      overlayItemFromToast({ id: 2, title: 'AI stopped', type: 'error' })
    ).toMatchObject({ tone: 'alerted', body: 'AI stopped' })
  })

  test('combines plain title and description but ignores render functions', () => {
    expect(
      overlayItemFromToast({
        id: 1,
        title: 'Message',
        description: 'More detail',
      })
    ).toMatchObject({ body: 'Message\nMore detail' })
    expect(overlayItemFromToast({ id: 2, title: () => 'custom' })).toBeNull()
  })

  test('gives updated toast content a different signature', () => {
    expect(overlayToastSignature({ id: 1, title: 'first' })).not.toBe(
      overlayToastSignature({ id: 1, title: 'second' })
    )
  })
})

function item(id: string) {
  return {
    id,
    title: id,
    body: id,
    tone: 'neutral' as const,
    ttlMs: 1_000,
  }
}
