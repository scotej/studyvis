import { describe, expect, test } from 'vitest'

import { createPttEdgeReconciler } from '@/features/system/pttEdgeReconciler'

describe('PTT edge reconciler', () => {
  test('unknown physical state preserves the ordinary shortcut path', () => {
    const reconciler = createPttEdgeReconciler()
    expect(reconciler.shortcutPressed()).toEqual([
      { edge: 'pressed', source: 'shortcut' },
    ])
    expect(reconciler.shortcutReleased()).toEqual([
      { edge: 'released', source: 'shortcut' },
    ])
  })

  test('an unreconciled later Pressed fails closed after a lost Released', () => {
    const reconciler = createPttEdgeReconciler()
    expect(reconciler.shortcutPressed()).toEqual([
      { edge: 'pressed', source: 'shortcut' },
    ])

    // The native Released for the first hold was lost. Without an
    // authoritative physical watcher this second Pressed is ambiguous, so
    // mute rather than leave the first hold live across the gap.
    expect(reconciler.shortcutPressed()).toEqual([
      { edge: 'released', source: 'shortcut-failsafe' },
    ])

    // The later hold's Released settles the stream; the next Pressed starts a
    // fresh, known-good hold instead of remaining latched muted.
    expect(reconciler.shortcutReleased()).toEqual([
      { edge: 'released', source: 'shortcut' },
    ])
    expect(reconciler.shortcutPressed()).toEqual([
      { edge: 'pressed', source: 'shortcut' },
    ])
  })

  test('a shortcut press while the physical key is up is deferred', () => {
    const reconciler = createPttEdgeReconciler()
    expect(reconciler.physicalState(false)).toEqual([])
    expect(reconciler.shortcutPressed()).toEqual([])
    expect(reconciler.snapshot()).toEqual({
      physicalHeld: false,
      deferredShortcutPress: true,
    })

    expect(reconciler.physicalState(true)).toEqual([
      { edge: 'pressed', source: 'physical-reconcile' },
    ])
    expect(reconciler.snapshot().deferredShortcutPress).toBe(false)
  })

  test('a delayed press cannot reactivate after physical release', () => {
    const reconciler = createPttEdgeReconciler()
    reconciler.physicalState(true)
    expect(reconciler.shortcutPressed()).toEqual([
      { edge: 'pressed', source: 'shortcut' },
    ])
    expect(reconciler.physicalState(false)).toEqual([
      { edge: 'released', source: 'physical-watch' },
    ])

    // Carbon/global-hotkey delivers an old Pressed after the watcher already
    // proved the physical key is up. It is held pending rather than emitted.
    expect(reconciler.shortcutPressed()).toEqual([])
    expect(reconciler.snapshot().deferredShortcutPress).toBe(true)
  })

  test('a matching shortcut release discards a deferred stale press', () => {
    const reconciler = createPttEdgeReconciler()
    reconciler.physicalState(false)
    reconciler.shortcutPressed()
    expect(reconciler.shortcutReleased()).toEqual([])
    expect(reconciler.snapshot().deferredShortcutPress).toBe(false)
  })

  test('the next physical hold can consume a deferred press', () => {
    const reconciler = createPttEdgeReconciler()
    reconciler.physicalState(false)
    reconciler.shortcutPressed()

    expect(reconciler.physicalState(true)).toEqual([
      { edge: 'pressed', source: 'physical-reconcile' },
    ])
    // The actual Carbon Pressed for this hold is known to belong to the same
    // physical hold, so it remains idempotent instead of taking the fallback
    // emergency-mute path used when physical state is unknown.
    expect(reconciler.shortcutPressed()).toEqual([])
  })

  test('physical release is emitted only on a true-to-false transition', () => {
    const reconciler = createPttEdgeReconciler()
    expect(reconciler.physicalState(false)).toEqual([])
    expect(reconciler.physicalState(false)).toEqual([])
    expect(reconciler.physicalState(true)).toEqual([])
    expect(reconciler.physicalState(false)).toEqual([
      { edge: 'released', source: 'physical-watch' },
    ])
    expect(reconciler.physicalState(false)).toEqual([])
  })

  test('an unobservable rebind clears deferred state', () => {
    const reconciler = createPttEdgeReconciler()
    reconciler.physicalState(false)
    reconciler.shortcutPressed()
    expect(reconciler.snapshot().deferredShortcutPress).toBe(true)

    expect(reconciler.physicalState(null)).toEqual([])
    expect(reconciler.snapshot()).toEqual({
      physicalHeld: null,
      deferredShortcutPress: false,
    })
    expect(reconciler.shortcutPressed()).toEqual([
      { edge: 'pressed', source: 'shortcut' },
    ])
  })
})
