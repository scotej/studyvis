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

  test('a first physical-up sample releases a logical hold', () => {
    const reconciler = createPttEdgeReconciler()

    // The renderer missed the monitor's initial physical-up baseline, so the
    // shortcut starts a hold while physical state is still unknown. Carbon's
    // matching Released edge is then lost. A current false level must still
    // end the logical hold without requiring a previously delivered true.
    expect(reconciler.shortcutPressed()).toEqual([
      { edge: 'pressed', source: 'shortcut' },
    ])
    expect(reconciler.physicalState(false)).toEqual([
      { edge: 'released', source: 'physical-watch' },
    ])
    expect(reconciler.snapshot()).toEqual({
      physicalHeld: false,
      deferredShortcutPress: true,
    })

    // Confirmation copies remain harmless, and a later Carbon Released only
    // clears the retained native intent instead of producing another edge.
    expect(reconciler.physicalState(false)).toEqual([])
    expect(reconciler.shortcutReleased()).toEqual([])
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

    // A further Pressed while that native stream is still unsettled stays
    // muted. Only the matching Released proves the ambiguous hold ended.
    expect(reconciler.shortcutPressed()).toEqual([])

    // The later hold's Released settles the stream; the next Pressed starts a
    // fresh, known-good hold instead of remaining latched muted.
    expect(reconciler.shortcutReleased()).toEqual([
      { edge: 'released', source: 'shortcut' },
    ])
    expect(reconciler.shortcutPressed()).toEqual([
      { edge: 'pressed', source: 'shortcut' },
    ])
  })

  test('a session reset cannot discard the next session first hold', () => {
    const reconciler = createPttEdgeReconciler()
    expect(reconciler.shortcutPressed()).toEqual([
      { edge: 'pressed', source: 'shortcut' },
    ])

    // The first session tears down while held, and native shortcut teardown
    // loses its Released edge. The next room starts with a clean logical hold
    // even though this app-lifetime reconciler instance is reused.
    reconciler.reset()
    expect(reconciler.shortcutPressed()).toEqual([
      { edge: 'pressed', source: 'shortcut' },
    ])
    expect(reconciler.shortcutReleased()).toEqual([
      { edge: 'released', source: 'shortcut' },
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
    // proved the physical key is up. It remains pending rather than emitted.
    expect(reconciler.shortcutPressed()).toEqual([])
    expect(reconciler.snapshot().deferredShortcutPress).toBe(true)
  })

  test('a matching shortcut release discards a deferred stale press', () => {
    const reconciler = createPttEdgeReconciler()
    reconciler.physicalState(false)
    reconciler.shortcutPressed()
    expect(reconciler.shortcutReleased()).toEqual([])
    expect(reconciler.snapshot().deferredShortcutPress).toBe(false)

    // A stale later physical true cannot activate once native Released has
    // cleared the shortcut intent.
    expect(reconciler.physicalState(true)).toEqual([])
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

  test('physical state catch-up restores a press muted by an early false', () => {
    const reconciler = createPttEdgeReconciler()

    // Carbon wins the race and activates while CoreGraphics is still unknown.
    expect(reconciler.shortcutPressed()).toEqual([
      { edge: 'pressed', source: 'shortcut' },
    ])
    // A still-up/late baseline fails closed but retains native key intent.
    expect(reconciler.physicalState(false)).toEqual([
      { edge: 'released', source: 'physical-watch' },
    ])
    // Once CoreGraphics observes the same current hold, it is restored rather
    // than remaining muted until the user completes another key cycle.
    expect(reconciler.physicalState(true)).toEqual([
      { edge: 'pressed', source: 'physical-reconcile' },
    ])
  })

  test('physical release is emitted only once for repeated false levels', () => {
    const reconciler = createPttEdgeReconciler()
    expect(reconciler.physicalState(false)).toEqual([])
    expect(reconciler.physicalState(false)).toEqual([])
    expect(reconciler.physicalState(true)).toEqual([])
    expect(reconciler.physicalState(false)).toEqual([
      { edge: 'released', source: 'physical-watch' },
    ])
    expect(reconciler.physicalState(false)).toEqual([])
  })

  test('shortcut release clears intent before a stale physical true', () => {
    const reconciler = createPttEdgeReconciler()
    reconciler.physicalState(true)
    expect(reconciler.shortcutPressed()).toEqual([
      { edge: 'pressed', source: 'shortcut' },
    ])
    expect(reconciler.shortcutReleased()).toEqual([
      { edge: 'released', source: 'shortcut' },
    ])

    // A trailing physical transition may produce a duplicate release, but it
    // cannot recreate the logical hold because shortcutDown is already clear.
    expect(reconciler.physicalState(false)).toEqual([
      { edge: 'released', source: 'physical-watch' },
    ])
    expect(reconciler.physicalState(true)).toEqual([])
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
