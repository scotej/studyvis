import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useShallow } from 'zustand/react/shallow'

import { AuditLogPanel, type AuditLogEntry } from '@/components/AuditLogPanel'
import { SessionTimer } from '@/components/SessionTimer'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { VideoGrid } from '@/components/VideoGrid'
import { VideoTile } from '@/components/VideoTile'
import { useIdentity } from '@/features/identity'
import { signWithKeyring } from '@/lib/db/identity'
import type { PomodoroPreset } from '@/lib/pomodoro-types'
import { isMacLikePlatform } from '@/lib/utils'
import {
  buildAuditEvent,
  useAuditStore,
  verifyIncomingAuditEvent,
} from '@/stores/auditStore'
import { usePomodoroStore } from '@/stores/pomodoroStore'
import { useSessionStore } from '@/stores/sessionStore'
import { usePttStore } from '@/stores/pttStore'

import {
  AUDIT_ACTION,
  AUDIT_KIND_LABELS,
  type AuditEvent,
  type AuditEventDetail,
  type AuditEventKind,
} from './audit'
import { startHelloProtocol } from './hello'
import { PTT_STATE_ACTION } from './lifecycle'
import { startPomodoroController, type PeerOrderingEntry } from './pomodoro'

const MEDIA_CONSTRAINTS: MediaStreamConstraints = { video: true, audio: true }
const isDev = import.meta.env.DEV

type PttPayload = { active: boolean }

// Composed session feature surface (DESIGN-SYSTEM.md §8.3): tiles for self +
// each peer, PTT-driven mute on the local audio track, an audit log right
// rail, a Pomodoro timer in the bottom bar, and a Leave button. Mounted
// whenever the session store reports an active session.
export function SessionView() {
  const room = useSessionStore((s) => s.room)
  const sessionLeave = useSessionStore((s) => s.leave)
  const sessionTopic = useSessionStore((s) => s.sessionTopic)
  const startedAt = useSessionStore((s) => s.startedAt)
  const peers = useSessionStore((s) => s.peers)
  const setPeerHello = useSessionStore((s) => s.setPeerHello)
  const { identity } = useIdentity()
  const pttActive = usePttStore((s) => s.active)
  const auditEvents = useAuditStore((s) => s.events)
  // useShallow stops the hello+audit+pomodoro effect from re-firing on every
  // 5-second broadcaster tick: without it the selector returns a fresh
  // object literal each store mutation, which would re-render SessionView
  // and (because `useIdentity` rebuilds its `actions` object on every
  // render) churn the effect's dep array — tearing down the controller
  // mid-session. The fix is two-fold: (1) shallow-equal the slice here,
  // (2) use the module-imported `signWithKeyring` directly so the dep
  // array carries a stable function reference.
  const pomodoroSnapshot = usePomodoroStore(
    useShallow((s) => ({
      phase: s.phase,
      endsAt: s.endsAt,
      preset: s.preset,
      broadcasterEdPubkey: s.broadcasterEdPubkey,
      iAmBroadcaster: s.iAmBroadcaster,
    }))
  )

  const [localStream, setLocalStream] = useState<MediaStream | null>(null)
  const [mediaError, setMediaError] = useState<string | null>(null)
  const [remoteStreams, setRemoteStreams] = useState<
    Record<string, MediaStream>
  >({})
  const [peerPtt, setPeerPtt] = useState<Record<string, boolean>>({})
  const localStreamRef = useRef<MediaStream | null>(null)
  const pttSendRef = useRef<((payload: PttPayload) => Promise<void[]>) | null>(
    null
  )
  // Stable refs the audit/pomodoro wiring closes over. Avoids re-creating the
  // hello/audit/pomodoro pipeline on every render (which would resend
  // hellos and reset broadcaster state).
  const emitAuditRef = useRef<
    ((kind: AuditEventKind, detail?: AuditEventDetail) => Promise<void>) | null
  >(null)
  const pomodoroStartRef = useRef<((preset: PomodoroPreset) => void) | null>(
    null
  )
  const pomodoroStopRef = useRef<(() => void) | null>(null)

  // Capture the camera + mic once per active session and add the resulting
  // MediaStream to the trystero room. trystero forwards new tracks to all
  // current peers and to peers who join later (Context7 docs / README §
  // Stream Audio and Video).
  useEffect(() => {
    if (!room) return
    let cancelled = false
    let acquiredStream: MediaStream | null = null
    void (async () => {
      try {
        const stream =
          await navigator.mediaDevices.getUserMedia(MEDIA_CONSTRAINTS)
        if (cancelled) {
          stopTracks(stream)
          return
        }
        acquiredStream = stream
        // Default-muted (PLAN.md §5: "Default-muted; PTT key unmutes only
        // while held."). The PTT effect below toggles enabled-ness.
        for (const t of stream.getAudioTracks()) t.enabled = false
        room.addStream(stream)
        setLocalStream(stream)
        localStreamRef.current = stream
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'camera / mic unavailable'
        setMediaError(message)
      }
    })()
    return () => {
      cancelled = true
      if (acquiredStream) {
        try {
          room.removeStream(acquiredStream)
        } catch {
          // best-effort
        }
        stopTracks(acquiredStream)
      }
      localStreamRef.current = null
      setLocalStream(null)
    }
  }, [room])

  // Bind peer streams to per-peer state. trystero replays existing peers when
  // we register the stream callback, so this works for both already-present
  // peers and joiners. We also drop stream + PTT entries when a peer leaves
  // — this keeps cleanup inside an event callback so the lint rule against
  // "setState synchronously inside an effect body" doesn't fire.
  useEffect(() => {
    if (!room) return
    room.onPeerStream((stream, peerId) => {
      setRemoteStreams((cur) => ({ ...cur, [peerId]: stream }))
      const cur = useSessionStore.getState().peers[peerId]
      if (cur) useSessionStore.getState().setPeerStream(peerId, true)
    })
    room.onPeerLeave((peerId) => {
      setRemoteStreams((cur) => {
        if (!(peerId in cur)) return cur
        const next = { ...cur }
        delete next[peerId]
        return next
      })
      setPeerPtt((cur) => {
        if (!(peerId in cur)) return cur
        const next = { ...cur }
        delete next[peerId]
        return next
      })
    })
  }, [room])

  // PTT broadcast: send our active-state on every change so peers can render
  // the PTT indicator. ARCHITECTURE.md §7's data channel carries this.
  useEffect(() => {
    if (!room) return
    const action = room.makeAction<PttPayload>(PTT_STATE_ACTION)
    pttSendRef.current = action.send
    action.receive((data, peerId) => {
      const active = Boolean((data as PttPayload)?.active)
      setPeerPtt((cur) => ({ ...cur, [peerId]: active }))
      useSessionStore.getState().setPeerPtt(peerId, active)
    })
    return () => {
      pttSendRef.current = null
    }
  }, [room])

  // Reflect local PTT state on the local audio track AND broadcast it so
  // peers can light their PTT indicator while we're transmitting.
  useEffect(() => {
    const stream = localStreamRef.current
    if (stream) {
      for (const t of stream.getAudioTracks()) t.enabled = pttActive
    }
    const send = pttSendRef.current
    if (send) void send({ active: pttActive })
  }, [pttActive])

  // Hello + audit + pomodoro pipeline. Wired once per (room, identity).
  // Tearing down on either change cleans up timers + resets stores.
  useEffect(() => {
    if (!room || !identity || !sessionTopic || !startedAt) return
    let stopped = false
    const myEdPubkeyHex = identity.ed_pubkey_hex
    const myDisplayName = identity.display_name
    // Module-imported sign — stable reference across renders. Using
    // `actions.signWithKeyring` from `useIdentity` would change identity
    // every render and tear the controller down (see the snapshot
    // selector comment above).
    const sign = signWithKeyring

    const helloHandle = startHelloProtocol({
      room,
      myEdPubkeyHex,
      myDisplayName,
      selfJoinedAt: startedAt,
      sign,
      onPeerHello: (peerId, hello) => setPeerHello(peerId, hello),
      onPeerLeave: () => {
        // The session store's peerLeft handler drops the binding via
        // `peers` map mutation; nothing to do here beyond the existing
        // wireSessionRoom listener.
      },
    })

    const auditAction = room.makeAction<AuditEvent>(AUDIT_ACTION)

    const emitAudit = async (
      kind: AuditEventKind,
      detail: AuditEventDetail = {}
    ) => {
      const event = await buildAuditEvent({
        sessionTopic,
        myEdPubkeyHex,
        kind,
        detail,
        sign,
      })
      // Append local first so the panel reflects our own actions
      // immediately, even if broadcast fails.
      useAuditStore.getState().append(event)
      try {
        await auditAction.send(event)
      } catch (err) {
        console.error('audit broadcast failed:', err)
      }
    }
    emitAuditRef.current = emitAudit

    auditAction.receive((data, peerId) => {
      const expectedEd =
        useSessionStore.getState().peers[peerId]?.edPubkeyHex ?? null
      const verified = verifyIncomingAuditEvent(data, peerId, expectedEd)
      if (!verified) return
      useAuditStore.getState().append(verified)
    })

    const controller = startPomodoroController({
      room,
      myEdPubkeyHex,
      selfJoinedAt: startedAt,
      getAllPeerOrdering: () => collectOrdering(myEdPubkeyHex, startedAt),
      resolveSenderEdPubkey: (peerId) =>
        useSessionStore.getState().peers[peerId]?.edPubkeyHex ?? null,
      onSnapshot: (snapshot) => usePomodoroStore.getState().apply(snapshot),
      onPomodoroStart: (preset) => {
        void emitAudit('pomodoro_start', { preset })
      },
      onPomodoroEnd: () => {
        void emitAudit('pomodoro_end', {})
      },
    })
    pomodoroStartRef.current = controller.start
    pomodoroStopRef.current = controller.stop

    // Send our hello first; once it's been written to all currently-connected
    // peers in trystero's per-channel order, fire our "joined" audit event
    // so receivers already have the peerId↔ed_pubkey binding.
    void (async () => {
      try {
        await helloHandle.ourHelloSent
      } catch {
        // Hello broadcast failures are best-effort; we still emit "joined"
        // locally so the session-log panel reflects our presence.
      }
      if (stopped) return
      void emitAudit('joined', {})
    })()

    return () => {
      stopped = true
      controller.teardown()
      helloHandle.teardown()
      emitAuditRef.current = null
      pomodoroStartRef.current = null
      pomodoroStopRef.current = null
    }
  }, [room, identity, sessionTopic, startedAt, setPeerHello])

  const handleLeave = useCallback(() => {
    if (!sessionLeave) return
    void (async () => {
      const emit = emitAuditRef.current
      if (emit) {
        try {
          await emit('left', {})
        } catch {
          // best-effort; never block leaving on a failed broadcast
        }
      }
      try {
        await sessionLeave()
      } catch (err) {
        const message = err instanceof Error ? err.message : 'could not leave'
        toast.error(message)
      }
    })()
  }, [sessionLeave])

  const handleStartPomodoro = useCallback((preset: PomodoroPreset) => {
    pomodoroStartRef.current?.(preset)
  }, [])
  const handleStopPomodoro = useCallback(() => {
    pomodoroStopRef.current?.()
  }, [])

  const elapsed = useElapsed(startedAt)
  const auditEntries = useMemo(
    () => mapAuditEntries(auditEvents, identity, peers),
    [auditEvents, identity, peers]
  )

  if (!room) return null

  const peerEntries = Object.values(peers)
  const youName = identity?.display_name ?? ''
  const broadcasterName = pomodoroSnapshot.iAmBroadcaster
    ? 'you'
    : pomodoroSnapshot.broadcasterEdPubkey
      ? (peerEntries.find(
          (p) => p.edPubkeyHex === pomodoroSnapshot.broadcasterEdPubkey
        )?.displayName ?? null)
      : null

  return (
    <main
      className="flex min-h-screen flex-col bg-bg-base text-text-primary"
      aria-label="Active session"
    >
      <div className="flex min-h-0 flex-1">
        <div className="flex-1 px-6 py-6">
          {mediaError ? (
            <div className="mb-4 rounded-md border border-status-alerted bg-bg-surface px-4 py-3 text-sm text-status-alerted">
              Couldn’t access camera or microphone: {mediaError}
            </div>
          ) : null}
          <VideoGrid>
            <VideoTile
              key="local"
              name={youName}
              stream={localStream}
              ptt={pttActive}
              isLocal
            />
            {peerEntries.map((peer) => (
              <VideoTile
                key={peer.peerId}
                name={peer.displayName ?? peerLabel(peer.peerId)}
                stream={remoteStreams[peer.peerId] ?? null}
                ptt={peerPtt[peer.peerId] ?? false}
              />
            ))}
          </VideoGrid>
        </div>
        <AuditLogPanel events={auditEntries} />
      </div>
      <footer className="flex items-center justify-between gap-4 border-t border-border-subtle bg-bg-surface px-6 py-4 text-sm">
        <span className="flex items-center gap-2 text-text-secondary">
          hold <Kbd>{isMacLikePlatform() ? '⌘[' : 'Ctrl+['}</Kbd> to talk
        </span>
        <span className="flex items-center gap-4">
          <span className="font-mono tabular-nums text-text-secondary">
            {elapsed}
          </span>
          <SessionTimer
            phase={pomodoroSnapshot.phase}
            preset={pomodoroSnapshot.preset}
            endsAt={pomodoroSnapshot.endsAt}
            iAmBroadcaster={pomodoroSnapshot.iAmBroadcaster}
            broadcasterName={broadcasterName}
            onStart={handleStartPomodoro}
            onStop={handleStopPomodoro}
          />
          {isDev ? (
            <DebugBreakButtons
              onPause={() => emitAuditRef.current?.('paused_break', {})}
              onResume={() => emitAuditRef.current?.('resumed', {})}
            />
          ) : null}
        </span>
        <Button variant="secondary" size="sm" onClick={handleLeave}>
          Leave
        </Button>
      </footer>
    </main>
  )
}

function DebugBreakButtons({
  onPause,
  onResume,
}: {
  onPause: () => void
  onResume: () => void
}) {
  return (
    <span className="flex items-center gap-1">
      <Button
        size="sm"
        variant="ghost"
        onClick={onPause}
        title="Debug: emit paused_break audit event"
      >
        break
      </Button>
      <Button
        size="sm"
        variant="ghost"
        onClick={onResume}
        title="Debug: emit resumed audit event"
      >
        back
      </Button>
    </span>
  )
}

function stopTracks(stream: MediaStream): void {
  for (const track of stream.getTracks()) {
    try {
      track.stop()
    } catch {
      // already-stopped tracks throw on some platforms; ignore.
    }
  }
}

function peerLabel(peerId: string): string {
  return `Peer ${peerId.slice(0, 6)}`
}

function collectOrdering(
  myEdPubkeyHex: string,
  selfJoinedAt: number
): PeerOrderingEntry[] {
  const peers = useSessionStore.getState().peers
  const out: PeerOrderingEntry[] = [
    { ed_pubkey_hex: myEdPubkeyHex, joined_at: selfJoinedAt },
  ]
  for (const p of Object.values(peers)) {
    if (p.edPubkeyHex && p.joinedAt != null) {
      out.push({ ed_pubkey_hex: p.edPubkeyHex, joined_at: p.joinedAt })
    }
  }
  return out
}

function mapAuditEntries(
  events: ReadonlyArray<{
    seq: number
    who: string
    kind: AuditEventKind
    ts: number
  }>,
  identity: { ed_pubkey_hex: string; display_name: string } | null,
  peers: Record<
    string,
    { edPubkeyHex: string | null; displayName: string | null }
  >
): AuditLogEntry[] {
  // Build a one-shot ed_pubkey → name map. The local user's own identity
  // wins for self entries; peers with bindings supply their own names.
  const byEdPubkey = new Map<string, string>()
  if (identity) {
    byEdPubkey.set(identity.ed_pubkey_hex, identity.display_name)
  }
  for (const p of Object.values(peers)) {
    if (p.edPubkeyHex && p.displayName) {
      byEdPubkey.set(p.edPubkeyHex, p.displayName)
    }
  }
  return events.map((e) => ({
    seq: e.seq,
    name: byEdPubkey.get(e.who) ?? `Peer ${e.who.slice(0, 6)}`,
    description: AUDIT_KIND_LABELS[e.kind],
    ts: e.ts,
  }))
}

function useElapsed(startedAt: number | null): string {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const handle = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(handle)
  }, [])
  if (!startedAt) return '00:00'
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000))
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}
