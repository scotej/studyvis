// Mounted once in App.tsx: wires Rust global-shortcut PTT edges to the PTT
// store. Carbon/global-hotkey remains the low-latency path; on macOS a
// CoreGraphics watcher also publishes current physical key state so delayed or
// dropped native edges can be reconciled without turning Pressed into a toggle.
// No window-blur release failsafe: the shortcut is intentionally system-wide.

import { useEffect } from 'react'

import { listen, type UnlistenFn } from '@tauri-apps/api/event'

import {
  setDiagnosticsSnapshotHook,
  type DiagnosticsTrigger,
} from '@/lib/diagnostics'
import { logHealth, logger } from '@/lib/log'
import type { TopicRoom } from '@/lib/trystero'
import { detectChromePlatform } from '@/lib/windowChrome'
import { MAX_HOLD_MS, usePttStore } from '@/stores/pttStore'
import { useSessionStore, type PeerSnapshot } from '@/stores/sessionStore'

import {
  readPttBroadcastMirror,
  resetPttBroadcastMirror,
} from './pttBroadcastMirror'
import {
  classifyPttMediaSnapshot,
  collectPttMediaSnapshot,
  collectPttTrackSnapshot,
  diffPttMediaSnapshot,
  type PttMediaSnapshot,
} from './pttDiagnostics'
import type { PttObservation, PttPlatform } from './pttInvariants'
import { readPttRenderState } from './pttRenderProbe'
import {
  classifyPttStoreChange,
  createPttWatchdog,
  PTT_WATCHDOG_ACTIVE_MS,
  PTT_WATCHDOG_IDLE_MS,
  type PttWatchdogTick,
} from './pttWatchdog'
import {
  createPttEdgeReconciler,
  type ReconciledPttEdge,
} from './pttEdgeReconciler'
import { registerPttEventBridge, type BridgeListen } from './pttEventBridge'

export const PTT_FRIENDS_PRESSED = 'ptt-friends-pressed'
export const PTT_FRIENDS_RELEASED = 'ptt-friends-released'
export const PTT_FRIENDS_PHYSICAL_STATE = 'ptt-friends-physical-state'

const log = logger.child('ptt')
// Separate scopes so a reader can grep the verdict without wading through the
// per-edge stream: `"scope":"ptt.invariant"` is the archive's own conclusion.
const invariantLog = log.child('invariant')
const watchdogLog = log.child('watchdog')

// First sample gives React's PTT effect time to mirror the store onto
// MediaStreamTrack.enabled. The settled sample is late enough for getStats()
// counters to show whether RTP progressed through the hold, while remaining
// short enough to capture the ~200 ms failure reported in #209.
const POST_EDGE_SAMPLE_MS = 40
const SETTLED_SAMPLE_MS = 350

type DiagnosticSource = 'local' | 'peer'
// 'watchdog' is the whole-session cadence (#226): the post-edge/settled pair
// only ever sampled within 350 ms of an edge, so a divergence that began
// between holds left no RTP evidence at all.
type PttSamplePhase = 'post-edge' | 'settled' | 'watchdog'
type PttEdge = 'pressed' | 'released' | 'changed'

// A timer must describe the edge that scheduled it, rather than whatever PTT
// state happens to exist when it eventually fires. The store revision catches
// local changes; peerEdgeSeq does the same for remote PTT correlation.
type PttDiagnosticBinding = {
  room: TopicRoom | null
  localActive: boolean
  localRevision: number
  activePeerIds: ReadonlySet<string>
  peerEdgeSeq: number
  heldMs: number | undefined
}

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

function pttPlatform(): PttPlatform {
  if (typeof navigator === 'undefined') return 'unknown'
  switch (detectChromePlatform()) {
    case 'mac':
      return 'macos'
    case 'linux':
      return 'linux'
    default:
      return 'windows'
  }
}

// Only macOS runs the CoreGraphics watcher. Everywhere else `physicalHeld`
// stays null for the whole run by design, and the invariants that depend on it
// must stay dormant rather than reporting the platform as a defect.
function physicalWatchExpected(platform: PttPlatform): boolean {
  return platform === 'macos'
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

    const platform = pttPlatform()
    const watchExpected = physicalWatchExpected(platform)
    const effectStartedAt = monotonicNow()

    // #226 — counts of what this renderer actually RECEIVED. Rust keeps its own
    // counts of what it emitted; the difference between the two is the only
    // proof an event was lost in the bridge, which is exactly the question the
    // #226 archives could not answer.
    let physicalEvents = 0
    let pressedEvents = 0
    let releasedEvents = 0
    let lastPhysicalAtMs: number | null = null
    // Suppresses the `store.changed` record for a change a native edge has
    // already fully described, so the per-hold volume does not double. True
    // only for the duration of the `press()` / `release()` call below, which
    // is exactly when the store subscriber runs.
    let inNativeEdgeMutation = false

    const observe = (wantStyle: boolean): PttObservation => {
      const store = usePttStore.getState()
      const session = useSessionStore.getState()
      const reconciler = edgeReconciler.snapshot()
      const nowMs = monotonicNow()
      const render = readPttRenderState(
        typeof document === 'undefined' ? null : document,
        wantStyle && typeof getComputedStyle === 'function'
          ? (element) => {
              const value = Number.parseFloat(
                getComputedStyle(element as unknown as Element).opacity
              )
              return Number.isFinite(value) ? value : null
            }
          : undefined
      )
      const broadcast = readPttBroadcastMirror()

      return {
        atMs: nowMs,
        sessionActive: session.room !== null,
        platform,
        physicalWatchExpected: watchExpected,
        peerPttActive: activePeerPttCount(session.peers),
        store: {
          active: store.active,
          awaitingRelease: store.awaitingRelease,
          heldSources: store.heldSources,
          revision: store.revision,
          holdMs:
            pressStartedAt === null
              ? null
              : Math.max(0, Math.round(nowMs - pressStartedAt)),
        },
        reconciler,
        track: collectPttTrackSnapshot(session.room),
        render,
        broadcast: {
          lastActive: broadcast.lastActive,
          msSinceSend: broadcast.msSinceSend,
          sends: broadcast.sends,
          sendFails: broadcast.sendFails,
          lastKind: broadcast.lastKind,
        },
        native: {
          lastPhysicalHeld: reconciler.physicalHeld,
          msSincePhysical:
            lastPhysicalAtMs === null
              ? null
              : Math.max(0, Math.round(nowMs - lastPhysicalAtMs)),
          physicalEvents,
          pressedEvents,
          releasedEvents,
        },
      }
    }

    const layerFields = (o: PttObservation) => ({
      store: o.store,
      reconciler: o.reconciler,
      track: o.track,
      render: o.render,
      broadcast: o.broadcast,
      native: o.native,
    })

    const onWatchdogTick = (tick: PttWatchdogTick) => {
      const o = tick.observation
      for (const event of tick.events) {
        if (event.kind === 'budget-exhausted') {
          log.warn('watchdog.budget_exhausted', {
            suppressedSinceMs: Math.round(event.suppressedSinceMs),
            tickSeq: tick.tickSeq,
            openViolations: tick.openViolations,
          })
          continue
        }
        const fields = {
          invariant: event.id,
          dwellMs: Math.round(event.dwellMs),
          ticks: event.ticks,
          enterCount: event.enterCount,
          revisionAtFirst: event.revisionAtFirst,
          revisionNow: event.revisionNow,
          tickSeq: tick.tickSeq,
          sessionActive: o.sessionActive,
          platform: o.platform,
          budgetLeft: tick.budgetLeft,
          ...layerFields(o),
        }
        if (event.kind === 'cleared') {
          invariantLog.debug('cleared', fields)
        } else if (event.level === 'error') {
          invariantLog.error(event.id, fields)
        } else {
          invariantLog.warn(event.id, fields)
        }
      }

      if (tick.gap) {
        watchdogLog.warn('timeline.gap', {
          ...tick.gap,
          sessionActive: o.sessionActive,
          storeActive: o.store.active,
          awaitingRelease: o.store.awaitingRelease,
          tickSeq: tick.tickSeq,
        })
      }

      if (tick.heartbeat) {
        watchdogLog.debug('heartbeat', {
          tickSeq: tick.tickSeq,
          ticks: tick.ticks,
          sessionActive: o.sessionActive,
          openViolations: tick.openViolations,
          budgetLeft: tick.budgetLeft,
          logHealth: logHealth(),
          ...layerFields(o),
        })
        // One RTP sample per heartbeat while a room is live: the existing
        // classifier already names a stalled or contradictory sender, but it
        // only ever ran inside the ±350 ms windows around an edge, so a
        // divergence that began between holds was structurally invisible.
        if (o.sessionActive) {
          scheduleMediaSample('local', 'changed', localEdgeSeq, 'watchdog', 0)
        }
      }
    }

    const watchdog = createPttWatchdog({ observe, onTick: onWatchdogTick })

    const captureDiagnosticBinding = (
      source: DiagnosticSource
    ): PttDiagnosticBinding => {
      const room = useSessionStore.getState().room
      if (room !== previousRoom) {
        previousRoom = room
        previousLocalSnapshot = null
        previousPeerSnapshot = null
      }

      const local = usePttStore.getState()
      const peers = useSessionStore.getState().peers
      return {
        room,
        localActive: local.active,
        localRevision: local.revision,
        activePeerIds: activePeerIds(peers),
        peerEdgeSeq,
        heldMs:
          source === 'local' && pressStartedAt !== null
            ? Math.max(0, Math.round(monotonicNow() - pressStartedAt))
            : undefined,
      }
    }

    const bindingRaced = (
      source: DiagnosticSource,
      binding: PttDiagnosticBinding
    ): boolean =>
      useSessionStore.getState().room !== binding.room ||
      (source === 'local'
        ? usePttStore.getState().revision !== binding.localRevision
        : peerEdgeSeq !== binding.peerEdgeSeq)

    const sampleMedia = async (
      source: DiagnosticSource,
      edge: PttEdge,
      sourceEdgeSeq: number,
      phase: PttSamplePhase,
      binding: PttDiagnosticBinding
    ) => {
      // An edge can change during the 40/350 ms delay, before getStats starts.
      // Do not sample its successor under the old edge label: that would let an
      // inactive release baseline/classify a prior press (or vice versa).
      if (bindingRaced(source, binding)) {
        sampleSeq += 1
        log.debug('media.snapshot_raced', {
          source,
          edge,
          edgeSeq: sourceEdgeSeq,
          sampleSeq,
          phase,
          localActive: binding.localActive,
          peerActiveCount: binding.activePeerIds.size,
          heldMs: binding.heldMs,
          stateChangedBeforeSample: true,
          stateChangedDuringSample: true,
          localRevisionAtEdge: binding.localRevision,
          localRevisionNow: usePttStore.getState().revision,
          peerEdgeSeqAtEdge: binding.peerEdgeSeq,
          peerEdgeSeqNow: peerEdgeSeq,
        })
        return
      }

      const snapshot = await collectPttMediaSnapshot(
        binding.room,
        binding.activePeerIds
      )
      if (cancelled) return

      // Retain the existing async-race guard too: a change while getStats is
      // pending is equally unsuitable for a baseline or contradiction verdict.
      const stateChangedDuringSample = bindingRaced(source, binding)
      const localActive = binding.localActive
      const peerActiveCount = binding.activePeerIds.size
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
        heldMs: binding.heldMs,
        stateChangedBeforeSample: false,
        stateChangedDuringSample,
        localRevisionAtEdge: binding.localRevision,
        localRevisionNow: usePttStore.getState().revision,
        peerEdgeSeqAtEdge: binding.peerEdgeSeq,
        peerEdgeSeqNow: peerEdgeSeq,
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
      phase: PttSamplePhase,
      delayMs: number
    ) => {
      const binding = captureDiagnosticBinding(source)
      const handle = setTimeout(() => {
        diagnosticTimers.delete(handle)
        void sampleMedia(source, edge, sourceEdgeSeq, phase, binding)
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
      const nativeHeld = before.heldSources.includes('native-shortcut')
      const duplicatePress = edge === 'pressed' && nativeHeld
      const duplicateRelease = edge === 'released' && !nativeHeld

      // Held across the mutation and nothing else. zustand notifies subscribers
      // synchronously inside `set`, so the subscriber observes this as true
      // precisely when the change is one a native edge is already recording;
      // a marker written after the call would always be too late, and the
      // subscriber would duplicate every edge `edge.received` explains.
      //
      // I92: this used to be a timestamp the subscriber compared against a
      // 50 ms window. A #226 archive caught it failing — a `reset` logged
      // 51 ms into a live 4.2-second hold, on a run whose timeline also shows
      // five-second gaps under llama inference. The window was least reliable
      // exactly when an archive matters most. A latch bounded by the call
      // itself cannot be outrun by a stall of any length.
      inNativeEdgeMutation = true
      try {
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
            press('native-shortcut')
          }
        } else if (!duplicateRelease) {
          release('native-shortcut')
        }
      } finally {
        inNativeEdgeMutation = false
      }

      const after = usePttStore.getState()
      const heldMs =
        pressStartedAt === null
          ? undefined
          : Math.max(0, Math.round(now - pressStartedAt))
      const duplicate = duplicatePress || duplicateRelease

      if (edgeSource === 'shortcut-failsafe') {
        log.warn('edge.failsafe_mute', {
          edgeSeq: currentEdgeSeq,
          heldMs,
          sessionActive: useSessionStore.getState().room !== null,
        })
      }

      const reconcilerAfter = edgeReconciler.snapshot()
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
        // #226 — which source owned the hold (a mixed native + button hold is
        // where a release from one leaves the other latched), and the raw
        // reconciler latches this edge left behind.
        heldSources: after.heldSources,
        revision: after.revision,
        physicalHeld: reconcilerAfter.physicalHeld,
        shortcutDown: reconcilerAfter.shortcutDown,
        logicalHoldActive: reconcilerAfter.logicalHoldActive,
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
    const unsubscribeSession = useSessionStore.subscribe((state, previous) => {
      if (state.room !== previous.room) {
        // PTT state is reset by the session owner, but this listener and its
        // native-edge reconciler live for the entire app. A Released edge can
        // be lost while the shortcut is unregistered during teardown; clear
        // that old hold before the next room's first Pressed edge arrives.
        edgeReconciler.reset()
        pressStartedAt = null
        previousRoom = state.room
        previousLocalSnapshot = null
        previousPeerSnapshot = null
        // A room owns its own dwell history and violation budget: a
        // disagreement that spanned a room change is a different fact from one
        // inside a room, and the previous room's peers no longer exist.
        watchdog.resetSession()
        resetPttBroadcastMirror()
      }
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
              physicalEvents += 1
              lastPhysicalAtMs = monotonicNow()
              const before = edgeReconciler.snapshot()
              const edges = edgeReconciler.physicalState(held)
              const after = edgeReconciler.snapshot()
              // #226 — the watcher now repeats each level for a bounded window,
              // so most of these events are confirmations of a state this
              // reconciler already holds. Logging every copy would push the
              // press/release history out of an exported diagnostic tail.
              if (held !== before.physicalHeld || edges.length > 0) {
                log.debug('physical.state', {
                  held,
                  previousHeld: before.physicalHeld,
                  deferredBefore: before.deferredShortcutPress,
                  deferredAfter: after.deferredShortcutPress,
                  shortcutDownAfter: after.shortcutDown,
                  logicalHoldActiveAfter: after.logicalHoldActive,
                  physicalEvents,
                })
              }
              dispatchReconciled(edges)
            },
            onReleased: () => {
              releasedEvents += 1
              const before = edgeReconciler.snapshot()
              const edges = edgeReconciler.shortcutReleased()
              if (before.deferredShortcutPress && edges.length === 0) {
                log.debug('edge.deferred_pressed_cancelled', {})
              }
              dispatchReconciled(edges)
            },
            onPressed: () => {
              pressedEvents += 1
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
        // #226 — a native emit whose timestamp precedes this record was
        // delivered into a webview with no listener attached, which is
        // otherwise indistinguishable from an event that was never sent.
        log.info('bridge.wired', {
          wireMs: Math.max(0, Math.round(monotonicNow() - effectStartedAt)),
          listeners: registered.length,
          platform,
          physicalWatchExpected: watchExpected,
          tauriRuntime: isTauriRuntime(),
        })
      } catch (err) {
        // `registerPttEventBridge` has already unwound any partially-wired
        // listeners, so a failure can never leave Pressed active without all
        // release/reconciliation paths.
        if (isTauriRuntime()) log.warn('bridge.listen_failed', { err })
      }
    }

    void wire()

    // #226 — pttStore had no logging at all, so the MAX_HOLD_MS failsafe muted
    // a stuck hold in total silence. Only changes the native edge stream cannot
    // already explain are recorded, so a normal hold costs nothing extra.
    const unsubscribePtt = usePttStore.subscribe((state, previous) => {
      if (
        state.active === previous.active &&
        state.awaitingRelease === previous.awaitingRelease &&
        state.heldSources === previous.heldSources
      ) {
        return
      }
      const cause = classifyPttStoreChange(previous, state)
      if (cause === null) return

      const nowMs = monotonicNow()
      // A native edge in this very call already wrote `edge.received`.
      if (cause === 'reset' && inNativeEdgeMutation) return

      const fields = {
        cause,
        active: state.active,
        awaitingRelease: state.awaitingRelease,
        heldSources: state.heldSources,
        previousActive: previous.active,
        previousAwaitingRelease: previous.awaitingRelease,
        previousHeldSourceCount: previous.heldSources.length,
        revision: state.revision,
        sessionActive: useSessionStore.getState().room !== null,
        holdMs:
          pressStartedAt === null
            ? null
            : Math.max(0, Math.round(nowMs - pressStartedAt)),
      }

      if (cause === 'failsafe') {
        log.warn('hold.failsafe', {
          ...fields,
          maxHoldMs: MAX_HOLD_MS,
          physicalHeld: edgeReconciler.snapshot().physicalHeld,
        })
        return
      }
      log.debug('store.changed', fields)
    })

    // The live state at the user's click. Written BEFORE the flush that
    // precedes the archive build, so it lands in the archive it describes —
    // the #226 report arrived with no record of what was true when it was made.
    const snapshotHook = (trigger: DiagnosticsTrigger) => {
      const o = watchdog.sample(true)
      log.info('export.snapshot', {
        trigger,
        sessionActive: o.sessionActive,
        platform: o.platform,
        wallMs: Date.now(),
        monoMs: Math.round(o.atMs),
        tickSeq: watchdog.tickSeq(),
        openViolations: watchdog.openViolations(),
        budgetLeft: watchdog.budgetLeft(),
        logHealth: logHealth(),
        ...layerFields(o),
      })
    }
    setDiagnosticsSnapshotHook(snapshotHook)
    watchdog.start()
    // Step 0 of the reading guide in pttInvariants.ts: what this run can and
    // cannot observe, stated before any symptom. On Windows and Linux
    // `physicalWatchExpected:false` is what tells a reader that the absence of
    // every physical record is the platform rather than a defect.
    watchdogLog.info('armed', {
      cadenceMs: PTT_WATCHDOG_ACTIVE_MS,
      idleCadenceMs: PTT_WATCHDOG_IDLE_MS,
      platform,
      physicalWatchExpected: watchExpected,
      maxHoldMs: MAX_HOLD_MS,
      probeAvailable: typeof document !== 'undefined',
      sessionActive: useSessionStore.getState().room !== null,
    })

    // No blur-release failsafe: the friends shortcut is GLOBAL, so PTT must
    // keep transmitting while the user holds the key in another app. macOS
    // physical-state reconciliation recovers dropped/delayed native edges;
    // the store's non-renewable MAX_HOLD_MS cutoff and per-session reset remain
    // platform-neutral final safeguards.

    return () => {
      cancelled = true
      watchdog.stop()
      // Only clear the slot if it is still ours: a remount installs the new
      // listener's hook before the old effect tears down.
      setDiagnosticsSnapshotHook(null)
      unsubscribePtt()
      unsubscribeSession()
      for (const handle of diagnosticTimers) clearTimeout(handle)
      diagnosticTimers.clear()
      for (const unlisten of unlisteners) unlisten()
    }
  }, [])

  return null
}
