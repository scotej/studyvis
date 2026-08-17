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
// CoreGraphics watcher reports the actual physical key state. The two streams
// can be delayed independently, so native key intent and the logical PTT hold
// are tracked separately:
//
// - `shortcutDown` means a Pressed edge has not yet been matched by Released.
// - `logicalHoldActive` means this reconciler emitted Pressed and has not yet
//   emitted a corresponding release.
//
// A current physical `false` is authoritative and always ends a logical hold,
// even if the renderer never received the initial physical baseline or the
// intervening `true`. It deliberately does not erase `shortcutDown`: if that
// `false` raced a new Carbon Pressed, the next physical `true` re-establishes
// the same hold instead of leaving the current press muted. Conversely, a
// stale/delayed physical `true` cannot activate anything after Carbon Released
// because Released clears `shortcutDown` first.
//
// On platforms without an authoritative physical state, the second Pressed
// before a Released is ambiguous: it might be a duplicate from one hold, or it
// might be a distinct new hold whose Released edge was lost. Treating it as a
// duplicate leaves the microphone live across an unobserved release, so that
// ambiguity fails closed by emitting one synthetic Released. The current hold
// is deliberately sacrificed; its matching Released clears the native edge
// stream and the following Pressed starts cleanly.
export function createPttEdgeReconciler(): PttEdgeReconciler {
  let physicalHeld: boolean | null = null
  let shortcutDown = false
  let logicalHoldActive = false

  const deferredShortcutPress = (): boolean =>
    shortcutDown && !logicalHoldActive && physicalHeld === false

  const snapshot = (): PttEdgeReconcilerSnapshot => ({
    physicalHeld,
    deferredShortcutPress: deferredShortcutPress(),
  })

  return {
    shortcutPressed: () => {
      if (shortcutDown) {
        if (physicalHeld === null && logicalHoldActive) {
          // Without a physical observation, never let an ambiguous second
          // press extend a potentially leaked hold. Keep shortcutDown set so
          // the matching Released still settles this native edge stream.
          logicalHoldActive = false
          return [{ edge: 'released', source: 'shortcut-failsafe' }]
        }

        // With physical state, either this is a duplicate callback for the
        // current hold or the Pressed is already deferred until key-down.
        return []
      }

      shortcutDown = true
      if (physicalHeld === false) return []

      logicalHoldActive = true
      return [{ edge: 'pressed', source: 'shortcut' }]
    },

    shortcutReleased: () => {
      const wasDeferred = deferredShortcutPress()
      shortcutDown = false

      if (wasDeferred) return []

      logicalHoldActive = false
      return [{ edge: 'released', source: 'shortcut' }]
    },

    physicalState: (held) => {
      const previous = physicalHeld
      physicalHeld = held

      if (held === null) {
        // A runtime rebind to an unobservable key should be rejected by Rust,
        // but fail closed against a hand-edited/legacy setting: never carry a
        // deferred edge from the previous binding into the new one. Preserve
        // a currently emitted hold so Carbon Released can still end it.
        if (!logicalHoldActive) shortcutDown = false
        return []
      }

      if (held) {
        if (shortcutDown && !logicalHoldActive) {
          logicalHoldActive = true
          return [{ edge: 'pressed', source: 'physical-reconcile' }]
        }
        return []
      }

      // `false` is authoritative current state. Do not require a previously
      // delivered `true`: the native monitor may have observed it while its
      // event was in flight or while the renderer listener was unavailable.
      // Keep shortcutDown until Carbon Released arrives so an early/stale
      // false cannot permanently consume the current press; a subsequent true
      // will restore it. Repeated false confirmations are idempotent after the
      // first release.
      const logicalWasActive = logicalHoldActive
      logicalHoldActive = false
      return previous === true || logicalWasActive
        ? [{ edge: 'released', source: 'physical-watch' }]
        : []
    },

    reset: () => {
      // A session owns exactly one logical PTT hold. Native shortcut delivery
      // may be unregistered before the old hold's Released edge arrives, so
      // never carry that latch into the next room. Keep the latest physical
      // observation: it remains authoritative until the watcher publishes
      // another state for the current key binding.
      shortcutDown = false
      logicalHoldActive = false
    },

    snapshot,
  }
}
