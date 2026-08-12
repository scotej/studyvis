export type LocalEdgeSource =
  'shortcut' | 'shortcut-failsafe' | 'physical-watch' | 'physical-reconcile'

export type ReconciledPttEdge = {
  edge: 'pressed' | 'released'
  source: LocalEdgeSource
}

export type PttEdgeReconcilerSnapshot = {
  physicalHeld: boolean | null
  deferredShortcutPress: boolean
}

export type PttEdgeReconciler = {
  shortcutPressed: () => ReconciledPttEdge[]
  shortcutReleased: () => ReconciledPttEdge[]
  physicalState: (held: boolean | null) => ReconciledPttEdge[]
  reset: () => void
  snapshot: () => PttEdgeReconcilerSnapshot
}

// Reconciles two independently delivered native signals on macOS:
// Carbon/global-hotkey remains the low-latency edge source, while the
// CoreGraphics watcher reports the actual physical key state. In particular,
// a Carbon Pressed that arrives after CoreGraphics has already observed the
// key released must never activate PTT. We defer that stale/early Pressed while
// physical state is `false`; if the key becomes physically held again, the
// deferred edge is consumed at that real key-down. If its matching shortcut
// Released arrives first, the deferred edge is discarded entirely.
//
// On platforms without an authoritative physical state, the second Pressed
// before a Released is ambiguous: it might be a duplicate from one hold, or it
// might be a distinct new hold whose Released edge was lost. Treating it as a
// duplicate leaves the microphone live across an unobserved release, so that
// ambiguity fails closed by emitting one synthetic Released. The current hold
// is deliberately sacrificed; its matching Released clears the native edge
// stream and the following Pressed starts cleanly. Once CoreGraphics reports
// the key is physically held, the same ambiguity disappears and duplicate
// Pressed edges remain idempotent.
export function createPttEdgeReconciler(): PttEdgeReconciler {
  let physicalHeld: boolean | null = null
  let deferredShortcutPress = false
  // True after this reconciler has emitted a Pressed but has not yet observed
  // a matching release. It is intentionally independent of the PTT store so
  // the fallback can end a lost native hold even after the store's max-hold
  // timer has already muted it.
  let shortcutHoldActive = false

  const snapshot = (): PttEdgeReconcilerSnapshot => ({
    physicalHeld,
    deferredShortcutPress,
  })

  return {
    shortcutPressed: () => {
      if (physicalHeld === false) {
        deferredShortcutPress = true
        return []
      }

      if (physicalHeld === true && shortcutHoldActive) {
        // The physical watcher proves this is another native callback for the
        // same physical hold, not a post-release Pressed that needs recovery.
        return []
      }

      if (physicalHeld === null && shortcutHoldActive) {
        // Without a physical observation, never let an ambiguous second press
        // extend a potentially leaked hold. Muting now lets the next completed
        // press/release cycle re-establish a known-good state.
        shortcutHoldActive = false
        return [{ edge: 'released', source: 'shortcut-failsafe' }]
      }

      shortcutHoldActive = true
      return [{ edge: 'pressed', source: 'shortcut' }]
    },

    shortcutReleased: () => {
      if (deferredShortcutPress && physicalHeld === false) {
        deferredShortcutPress = false
        return []
      }
      shortcutHoldActive = false
      return [{ edge: 'released', source: 'shortcut' }]
    },

    physicalState: (held) => {
      const previous = physicalHeld
      physicalHeld = held

      if (held === null) {
        // A runtime rebind to an unobservable key should be rejected by Rust,
        // but fail closed against a hand-edited/legacy setting: never carry
        // a deferred edge from the previous binding into the new one. Keep
        // the emitted hold, if any, so the first unreconciled Pressed gets the
        // conservative lost-release recovery above.
        deferredShortcutPress = false
        return []
      }

      if (held) {
        if (deferredShortcutPress) {
          deferredShortcutPress = false
          shortcutHoldActive = true
          return [{ edge: 'pressed', source: 'physical-reconcile' }]
        }
        return []
      }

      shortcutHoldActive = false
      return previous === true
        ? [{ edge: 'released', source: 'physical-watch' }]
        : []
    },

    reset: () => {
      // A session owns exactly one logical PTT hold. Native shortcut delivery
      // may be unregistered before the old hold's Released edge arrives, so
      // never carry that latch (or a deferred macOS edge) into the next room.
      // Keep the latest physical observation: it remains authoritative until
      // the watcher publishes another state for the current key binding.
      shortcutHoldActive = false
      deferredShortcutPress = false
    },

    snapshot,
  }
}
