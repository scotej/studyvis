import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test } from 'vitest'

import { SessionOverlayWindow } from '@/features/session/SessionOverlayWindow'
import {
  buildSessionOverlayWindowOptions,
  normalizeSessionOverlayPresentPayload,
  normalizeSessionOverlayWindowHeight,
  overlayItemFromToast,
  overlayToastSignature,
  SESSION_OVERLAY_WINDOW_MAX_HEIGHT,
  SESSION_OVERLAY_WINDOW_MIN_HEIGHT,
  SESSION_OVERLAY_WINDOW_WIDTH,
  sessionOverlayMeasurementTarget,
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

describe('session overlay presentation', () => {
  test('starts hidden at the minimum height with no native window shadow', () => {
    expect(
      buildSessionOverlayWindowOptions({ x: 10, y: 20 }, 'StudyVis')
    ).toMatchObject({
      width: SESSION_OVERLAY_WINDOW_WIDTH,
      height: SESSION_OVERLAY_WINDOW_MIN_HEIGHT,
      x: 10,
      y: 20,
      decorations: false,
      transparent: true,
      visible: false,
      shadow: false,
    })
  })

  test('rounds measured content and clamps it to safe window bounds', () => {
    expect(normalizeSessionOverlayWindowHeight(80)).toBe(
      SESSION_OVERLAY_WINDOW_MIN_HEIGHT
    )
    expect(normalizeSessionOverlayWindowHeight(211.2)).toBe(212)
    expect(normalizeSessionOverlayWindowHeight(999)).toBe(
      SESSION_OVERLAY_WINDOW_MAX_HEIGHT
    )
    expect(normalizeSessionOverlayWindowHeight(Number.NaN)).toBeNull()
    expect(normalizeSessionOverlayWindowHeight('212')).toBeNull()
  })

  test('rejects stale-shaped or malformed renderer measurements', () => {
    expect(
      normalizeSessionOverlayPresentPayload({ revision: 7, height: 211.2 })
    ).toEqual({ revision: 7, height: 212 })
    expect(
      normalizeSessionOverlayPresentPayload({ revision: 0, height: 212 })
    ).toBeNull()
    expect(
      normalizeSessionOverlayPresentPayload({ revision: 7, height: Infinity })
    ).toBeNull()
    expect(normalizeSessionOverlayPresentPayload(null)).toBeNull()
  })

  test('never lets an old visible measurement outrank newer pending content', () => {
    expect(sessionOverlayMeasurementTarget(7, 8, 7)).toBeNull()
    expect(sessionOverlayMeasurementTarget(8, 8, 7)).toBe('pending')
    expect(sessionOverlayMeasurementTarget(8, null, 8)).toBe('visible')
    expect(sessionOverlayMeasurementTarget(7, null, 8)).toBeNull()
  })

  test('keeps long notification text available instead of line-clamping it', () => {
    const body = Array.from(
      { length: 8 },
      (_, index) => `Detailed notification line ${index + 1}.`
    ).join('\n')
    const html = renderToStaticMarkup(
      createElement(SessionOverlayWindow, {
        initialSnapshot: {
          item: {
            id: 'long',
            title: 'Detailed update',
            body,
            tone: 'warning',
            createdAt: 1,
            expiresAt: 60_001,
          },
          queued: 0,
        },
      })
    )

    expect(html).toContain('data-testid="session-overlay-body"')
    expect(html).toContain('overflow-y-auto')
    expect(html).not.toContain('line-clamp')
    expect(html).toContain('Detailed notification line 8.')
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
