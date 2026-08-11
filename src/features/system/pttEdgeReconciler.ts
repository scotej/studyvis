export type LocalEdgeSource =
  'shortcut' | 'physical-watch' | 'physical-reconcile'

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
// On non-macOS (or a deliberately unobservable fallback) physical state stays
// `null`, preserving the ordinary Pressed/Released path with no added latency.
export function createPttEdgeReconciler(): PttEdgeReconciler {
  let physicalHeld: boolean | null = null
  let deferredShortcutPress = false

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
      return [{ edge: 'pressed', source: 'shortcut' }]
    },

    shortcutReleased: () => {
      if (deferredShortcutPress && physicalHeld === false) {
        deferredShortcutPress = false
        return []
      }
      return [{ edge: 'released', source: 'shortcut' }]
    },

    physicalState: (held) => {
      const previous = physicalHeld
      physicalHeld = held

      if (held === null) {
        // A runtime rebind to an unobservable key should be rejected by Rust,
        // but fail closed against a hand-edited/legacy setting: never carry a
        // deferred edge from the previous binding into the new one.
        deferredShortcutPress = false
        return []
      }

      if (held) {
        if (deferredShortcutPress) {
          deferredShortcutPress = false
          return [{ edge: 'pressed', source: 'physical-reconcile' }]
        }
        return []
      }

      return previous === true
        ? [{ edge: 'released', source: 'physical-watch' }]
        : []
    },

    snapshot,
  }
}
