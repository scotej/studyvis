// Mounted once in App.tsx: wires Rust global-shortcut PTT edges to the PTT
// store. Carbon/global-hotkey remains the low-latency path; on macOS a
// CoreGraphics watcher also publishes current physical key state so delayed or
// dropped native edges can be reconciled without turning Pressed into a toggle.
// No window-blur release failsafe: the shortcut is intentionally system-wide.

import { useEffect } from 'react'

import { listen, type UnlistenFn } from '@tauri-apps/api/event'

import { logger } from '@/lib/log'
import { usePttStore } from '@/stores/pttStore'
import { useSessionStore, type PeerSnapshot } from '@/stores/sessionStore'

import {
  classifyPttMediaSnapshot,
  collectPttMediaSnapshot,
  diffPttMediaSnapshot,
  type PttMediaSnapshot,
} from './pttDiagnostics'
import {
  createPttEdgeReconciler,
  type ReconciledPttEdge,
} from './pttEdgeReconciler'
import { registerPttEventBridge, type BridgeListen } from './pttEventBridge'

export const PTT_FRIENDS_PRESSED = 'ptt-friends-pressed'
export const PTT_FRIENDS_RELEASED = 'ptt-friends-released'
export const PTT_FRIENDS_PHYSICAL_STATE = 'ptt-friends-physical-state'

const log = logger.child('ptt')

// First sample gives React's PTT effect time to mirror the store onto
// MediaStreamTrack.enabled. The settled sample is late enough for getStats()
// counters to show whether RTP progressed through the hold, while remaining
// short enough to capture the ~200 ms failure reported in #209.
const POST_EDGE_SAMPLE_MS = 40
const SETTLED_SAMPLE_MS = 350

type DiagnosticSource = 'local' | 'peer'
type PttEdge = 'pressed' | 'released' | 'changed'

function monotonicNow(): number {
  return typeof performance === 'undefined' ? Date.now() : performance.now()
}

function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

function activePeerPttCount(peers: Record<string, PeerSnapshot>): number {
  return Object.values(peers).reduce(
    (count, peer) => count + (peer.ptt ? 1 : 0),
    0
  )
}

function activePeerIds(peers: Record<string, PeerSnapshot>): Set<string> {
  const ids = new Set<string>()
  for (const [peerId, peer] of Object.entries(peers)) {
    if (peer.ptt) ids.add(peerId)
  }
  return ids
}

function changedPeerPttCount(
  current: Record<string, PeerSnapshot>,
  previous: Record<string, PeerSnapshot>
): number {
  const peerIds = new Set([...Object.keys(current), ...Object.keys(previous)])
  let changed = 0
  for (const peerId of peerIds) {
    if ((current[peerId]?.ptt ?? false) !== (previous[peerId]?.ptt ?? false)) {
      changed += 1
    }
  }
  return changed
}

function physicalStatePayload(payload: unknown): boolean | null {
  return payload === true ? true : payload === false ? false : null
}

export function PttListener() {
  useEffect(() => {
    const unlisteners: UnlistenFn[] = []
    const diagnosticTimers = new Set<ReturnType<typeof setTimeout>>()
    const edgeReconciler = createPttEdgeReconciler()
    let cancelled = false
    let localEdgeSeq = 0
    let peerEdgeSeq = 0
    let sampleSeq = 0
    let pressStartedAt: number | null = null
    let previousLocalSnapshot: PttMediaSnapshot | null = null
    let previousPeerSnapshot: PttMediaSnapshot | null = null
    let previousRoom = useSessionStore.getState().room

    const press = usePttStore.getState().press
    const release = usePttStore.getState().release

    const sampleMedia = async (
      source: DiagnosticSource,
      edge: PttEdge,
      sourceEdgeSeq: number,
      phase: 'post-edge' | 'settled'
    ) => {
      const room = useSessionStore.getState().room
      if (room !== previousRoom) {
        previousRoom = room
        previousLocalSnapshot = null
        previousPeerSnapshot = null
      }

      // Capture PTT state and receiver correlation synchronously BEFORE any
      // getStats() await. A release/press that lands while stats are pending is
      // detected through the local revision / peer-edge generation below and
      // cannot be misclassified as a deterministic media contradiction.
      const localAtCapture = usePttStore.getState()
      const peersAtCapture = useSessionStore.getState().peers
      const activePeerIdsAtCapture = activePeerIds(peersAtCapture)
      const localRevisionAtCapture = localAtCapture.revision
      const peerEdgeSeqAtCapture = peerEdgeSeq
      const heldMsAtCapture =
        source === 'local' && pressStartedAt !== null
          ? Math.max(0, Math.round(monotonicNow() - pressStartedAt))
          : undefined

      const snapshot = await collectPttMediaSnapshot(
        room,
        activePeerIdsAtCapture
      )
      if (cancelled || useSessionStore.getState().room !== room) return

      const stateChangedDuringSample =
        source === 'local'
          ? usePttStore.getState().revision !== localRevisionAtCapture
          : peerEdgeSeq !== peerEdgeSeqAtCapture
      const localActive = localAtCapture.active
      const peerActiveCount = activePeerIdsAtCapture.size
      const previousSnapshot =
        source === 'local' ? previousLocalSnapshot : previousPeerSnapshot
      const delta = stateChangedDuringSample
        ? diffPttMediaSnapshot(null, snapshot)
        : diffPttMediaSnapshot(previousSnapshot, snapshot)

      // A raced or partial observation is useful debug evidence but must not
      // become the baseline for the next RTP delta.
      if (!stateChangedDuringSample && !snapshot.collectionError) {
        if (source === 'local') previousLocalSnapshot = snapshot
        else previousPeerSnapshot = snapshot
      }

      sampleSeq += 1
      const fields = {
        source,
        edge,
        edgeSeq: sourceEdgeSeq,
        sampleSeq,
        phase,
        localActive,
        peerActiveCount,
        heldMs: heldMsAtCapture,
        stateChangedDuringSample,
        media: snapshot,
        delta,
      }

      const issue = classifyPttMediaSnapshot({
        source,
        localActive,
        stateChangedDuringSample,
        snapshot,
      })
      if (issue) {
        if (issue.level === 'error') log.error(issue.message, fields)
        else log.warn(issue.message, fields)
      } else if (stateChangedDuringSample) {
        log.debug('media.snapshot_raced', fields)
      } else if (snapshot.collectionError) {
        log.debug('media.snapshot_partial', fields)
      } else {
        log.debug('media.snapshot', fields)
      }
    }

    const scheduleMediaSample = (
      source: DiagnosticSource,
      edge: PttEdge,
      sourceEdgeSeq: number,
      phase: 'post-edge' | 'settled',
      delayMs: number
    ) => {
      const handle = setTimeout(() => {
        diagnosticTimers.delete(handle)
        void sampleMedia(source, edge, sourceEdgeSeq, phase)
      }, delayMs)
      diagnosticTimers.add(handle)
    }

    const handleLocalEdge = ({
      edge,
      source: edgeSource,
    }: ReconciledPttEdge) => {
      localEdgeSeq += 1
      const currentEdgeSeq = localEdgeSeq
      const now = monotonicNow()
      const before = usePttStore.getState()
      const duplicatePress = edge === 'pressed' && before.awaitingRelease
      const duplicateRelease = edge === 'released' && !before.awaitingRelease

      if (edge === 'pressed') {
        if (duplicatePress) {
          log.debug('edge.duplicate_pressed', {
            edgeSeq: currentEdgeSeq,
            edgeSource,
            heldMs:
              pressStartedAt === null
                ? undefined
                : Math.max(0, Math.round(now - pressStartedAt)),
          })
        } else {
          pressStartedAt = now
          press()
        }
      } else if (!duplicateRelease) {
        release()
      }

      const after = usePttStore.getState()
      const heldMs =
        pressStartedAt === null
          ? undefined
          : Math.max(0, Math.round(now - pressStartedAt))
      const duplicate = duplicatePress || duplicateRelease

      log.debug('edge.received', {
        edge,
        edgeSource,
        edgeSeq: currentEdgeSeq,
        activeBefore: before.active,
        activeAfter: after.active,
        awaitingReleaseBefore: before.awaitingRelease,
        awaitingReleaseAfter: after.awaitingRelease,
        heldMs,
        duplicate,
        sessionActive: useSessionStore.getState().room !== null,
      })

      if (duplicate) return

      scheduleMediaSample(
        'local',
        edge,
        currentEdgeSeq,
        'post-edge',
        POST_EDGE_SAMPLE_MS
      )
      if (edge === 'pressed') {
        scheduleMediaSample(
          'local',
          edge,
          currentEdgeSeq,
          'settled',
          SETTLED_SAMPLE_MS
        )
      } else {
        pressStartedAt = null
      }
    }

    const dispatchReconciled = (edges: ReconciledPttEdge[]) => {
      for (const edge of edges) handleLocalEdge(edge)
    }

    // `SessionView` writes peer PTT action messages into sessionStore.peers.
    // Peer IDs are used only for in-memory receiver correlation; diagnostics
    // log aggregate counts and never serialize an identifier.
    const unsubscribePeerPtt = useSessionStore.subscribe((state, previous) => {
      if (state.peers === previous.peers) return
      const changedPeerCount = changedPeerPttCount(state.peers, previous.peers)
      if (changedPeerCount === 0) return

      const activeBeforeCount = activePeerPttCount(previous.peers)
      const activeAfterCount = activePeerPttCount(state.peers)
      const edge: PttEdge =
        activeAfterCount > activeBeforeCount
          ? 'pressed'
          : activeAfterCount < activeBeforeCount
            ? 'released'
            : 'changed'
      peerEdgeSeq += 1
      const currentEdgeSeq = peerEdgeSeq

      log.debug('peer.edge.received', {
        edge,
        edgeSeq: currentEdgeSeq,
        activeBeforeCount,
        activeAfterCount,
        changedPeerCount,
        sessionActive: state.room !== null,
      })

      scheduleMediaSample(
        'peer',
        edge,
        currentEdgeSeq,
        'post-edge',
        POST_EDGE_SAMPLE_MS
      )
      if (activeAfterCount > 0) {
        scheduleMediaSample(
          'peer',
          edge,
          currentEdgeSeq,
          'settled',
          SETTLED_SAMPLE_MS
        )
      }
    })

    const bridgeListen: BridgeListen = (eventName, handler) =>
      listen<unknown>(eventName, handler)

    const wire = async () => {
      try {
        const registered = await registerPttEventBridge(
          bridgeListen,
          {
            physicalState: PTT_FRIENDS_PHYSICAL_STATE,
            released: PTT_FRIENDS_RELEASED,
            pressed: PTT_FRIENDS_PRESSED,
          },
          {
            onPhysicalState: (payload) => {
              const held = physicalStatePayload(payload)
              const before = edgeReconciler.snapshot()
              const edges = edgeReconciler.physicalState(held)
              const after = edgeReconciler.snapshot()
              log.debug('physical.state', {
                held,
                previousHeld: before.physicalHeld,
                deferredBefore: before.deferredShortcutPress,
                deferredAfter: after.deferredShortcutPress,
              })
              dispatchReconciled(edges)
            },
            onReleased: () => {
              const before = edgeReconciler.snapshot()
              const edges = edgeReconciler.shortcutReleased()
              if (before.deferredShortcutPress && edges.length === 0) {
                log.debug('edge.deferred_pressed_cancelled', {})
              }
              dispatchReconciled(edges)
            },
            onPressed: () => {
              const before = edgeReconciler.snapshot()
              const edges = edgeReconciler.shortcutPressed()
              const after = edgeReconciler.snapshot()
              if (
                !before.deferredShortcutPress &&
                after.deferredShortcutPress &&
                edges.length === 0
              ) {
                log.debug('edge.pressed_deferred_physical_up', {})
              }
              dispatchReconciled(edges)
            },
          }
        )
        if (cancelled) {
          for (const unlisten of registered) unlisten()
          return
        }
        unlisteners.push(...registered)
      } catch (err) {
        // `registerPttEventBridge` has already unwound any partially-wired
        // listeners, so a failure can never leave Pressed active without all
        // release/reconciliation paths.
        if (isTauriRuntime()) log.warn('bridge.listen_failed', { err })
      }
    }

    void wire()

    // No blur-release failsafe: the friends shortcut is GLOBAL, so PTT must
    // keep transmitting while the user holds the key in another app. macOS
    // physical-state reconciliation recovers dropped/delayed native edges;
    // the store's non-renewable MAX_HOLD_MS cutoff and per-session reset remain
    // platform-neutral final safeguards.

    return () => {
      cancelled = true
      unsubscribePeerPtt()
      for (const handle of diagnosticTimers) clearTimeout(handle)
      diagnosticTimers.clear()
      for (const unlisten of unlisteners) unlisten()
    }
  }, [])

  return null
}
