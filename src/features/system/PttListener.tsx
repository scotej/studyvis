// Mounted once in App.tsx: wires the Rust global-shortcut PTT events
// (`ptt-friends-pressed` / `-released`) to the PTT store. Deliberately has NO
// window-blur release failsafe — the shortcut is system-wide, so PTT must
// keep transmitting while the user holds the key in another app; a dropped
// release is covered by the store's stuck-key guard and per-session reset
// (S2). No-op outside the Tauri runtime.

import { useEffect } from 'react'

import { listen, type UnlistenFn } from '@tauri-apps/api/event'

import { logger } from '@/lib/log'
import { usePttStore } from '@/stores/pttStore'
import {
  useSessionStore,
  type PeerSnapshot,
} from '@/stores/sessionStore'

import {
  collectPttMediaSnapshot,
  diffPttMediaSnapshot,
  type PttMediaSnapshot,
} from './pttDiagnostics'

export const PTT_FRIENDS_PRESSED = 'ptt-friends-pressed'
export const PTT_FRIENDS_RELEASED = 'ptt-friends-released'

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
  return (
    typeof window !== 'undefined' &&
    '__TAURI_INTERNALS__' in (window as Window & Record<string, unknown>)
  )
}

function activePeerPttCount(peers: Record<string, PeerSnapshot>): number {
  return Object.values(peers).reduce(
    (count, peer) => count + (peer.ptt ? 1 : 0),
    0
  )
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

export function PttListener() {
  useEffect(() => {
    const unlisteners: UnlistenFn[] = []
    const diagnosticTimers = new Set<ReturnType<typeof setTimeout>>()
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

      const snapshot = await collectPttMediaSnapshot(room)
      if (cancelled || useSessionStore.getState().room !== room) return

      // Read state after getStats resolves so a release racing the async sample
      // cannot be reported against stale state.
      const localActive = usePttStore.getState().active
      const peerActiveCount = activePeerPttCount(
        useSessionStore.getState().peers
      )
      const previousSnapshot =
        source === 'local' ? previousLocalSnapshot : previousPeerSnapshot
      const delta = diffPttMediaSnapshot(previousSnapshot, snapshot)
      if (source === 'local') previousLocalSnapshot = snapshot
      else previousPeerSnapshot = snapshot

      sampleSeq += 1
      const heldMs =
        source === 'local' && pressStartedAt !== null
          ? Math.max(0, Math.round(monotonicNow() - pressStartedAt))
          : undefined
      // The structured logger caps each object at 24 keys. Keep the media
      // snapshot and deltas nested so a full sample never drops the trailing
      // RTP counters that are most useful when diagnosing silence.
      const fields = {
        source,
        edge,
        edgeSeq: sourceEdgeSeq,
        sampleSeq,
        phase,
        localActive,
        peerActiveCount,
        heldMs,
        media: snapshot,
        delta,
      }

      // These are state contradictions, not traffic-volume heuristics. RTP byte
      // deltas remain debug telemetry because Opus DTX may legitimately produce
      // little/no traffic during silence. Sender contradictions diagnose the
      // local PTT path; receiver contradictions diagnose the peer path.
      if (
        source === 'local' &&
        localActive &&
        snapshot.peerConnectionCount > 0 &&
        snapshot.audioSenderCount === 0
      ) {
        log.warn('media.active_no_audio_sender', fields)
      } else if (
        source === 'local' &&
        localActive &&
        snapshot.audioSenderCount > 0 &&
        snapshot.enabledAudioSenderCount !== snapshot.audioSenderCount
      ) {
        log.error('media.active_sender_disabled', fields)
      } else if (
        source === 'local' &&
        !localActive &&
        snapshot.enabledAudioSenderCount > 0
      ) {
        log.error('media.inactive_sender_enabled', fields)
      } else if (
        source === 'local' &&
        localActive &&
        snapshot.audioSenderCount > 0 &&
        snapshot.liveAudioSenderCount !== snapshot.audioSenderCount
      ) {
        log.warn('media.audio_track_not_live', fields)
      } else if (
        source === 'peer' &&
        peerActiveCount > 0 &&
        snapshot.peerConnectionCount > 0 &&
        snapshot.audioReceiverCount === 0
      ) {
        log.warn('media.peer_active_no_audio_receiver', fields)
      } else if (
        source === 'peer' &&
        peerActiveCount > 0 &&
        snapshot.audioReceiverCount > 0 &&
        snapshot.liveAudioReceiverCount !== snapshot.audioReceiverCount
      ) {
        log.warn('media.peer_audio_track_not_live', fields)
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

    const handleLocalEdge = (edge: 'pressed' | 'released') => {
      localEdgeSeq += 1
      const currentEdgeSeq = localEdgeSeq
      const now = monotonicNow()
      const activeBefore = usePttStore.getState().active
      const duplicatePress = edge === 'pressed' && activeBefore

      if (edge === 'pressed') {
        if (duplicatePress) {
          // Drop repeats at the bridge so a native repeat burst cannot trigger
          // redundant renders or getStats sampling. The store remains
          // independently idempotent as a defence-in-depth contract for any
          // future caller that bypasses this listener.
          log.warn('edge.duplicate_pressed', {
            edgeSeq: currentEdgeSeq,
            heldMs:
              pressStartedAt === null
                ? undefined
                : Math.max(0, Math.round(now - pressStartedAt)),
          })
        } else {
          pressStartedAt = now
          press()
        }
      } else {
        release()
      }

      const activeAfter = usePttStore.getState().active
      const heldMs =
        pressStartedAt === null
          ? undefined
          : Math.max(0, Math.round(now - pressStartedAt))

      // Debug records are intentionally never throttled by the structured log
      // sink, so an issue attachment preserves the exact Pressed/Released order
      // instead of folding a repeat burst into one line.
      log.debug('edge.received', {
        edge,
        edgeSeq: currentEdgeSeq,
        activeBefore,
        activeAfter,
        heldMs,
        duplicate: duplicatePress,
        sessionActive: useSessionStore.getState().room !== null,
      })

      if (duplicatePress) return

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

    // `SessionView` writes peer PTT action messages into sessionStore.peers.
    // Observing that store here gives diagnostics a receiver-side edge without
    // coupling the logging code to the large session UI component. No peer IDs
    // are logged; only aggregate transition counts and inbound RTP counters.
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

    const wire = async () => {
      try {
        const a = await listen(PTT_FRIENDS_PRESSED, () =>
          handleLocalEdge('pressed')
        )
        if (cancelled) {
          a()
          return
        }
        unlisteners.push(a)

        const b = await listen(PTT_FRIENDS_RELEASED, () =>
          handleLocalEdge('released')
        )
        if (cancelled) {
          b()
          return
        }
        unlisteners.push(b)
      } catch (err) {
        // Outside a Tauri runtime (Vitest, Storybook, plain web preview) the
        // event bridge is expected to be absent. Only a real packaged/runtime
        // failure is diagnostic-worthy.
        if (isTauriRuntime()) log.warn('bridge.listen_failed', { err })
      }
    }

    void wire()

    // No blur-release failsafe: the friends shortcut is a GLOBAL shortcut whose
    // Released event is delivered system-wide regardless of window focus, so
    // PTT must keep transmitting while the user works in another app (the whole
    // point of hold-to-talk during a body-doubling session). Releasing on blur
    // would cut audio mid-sentence in exactly that scenario. The genuinely
    // dropped-release case is covered by the store's MAX_HOLD_MS stuck-key
    // failsafe plus the per-session reset().

    return () => {
      cancelled = true
      unsubscribePeerPtt()
      for (const handle of diagnosticTimers) clearTimeout(handle)
      diagnosticTimers.clear()
      for (const u of unlisteners) u()
    }
  }, [])

  return null
}
