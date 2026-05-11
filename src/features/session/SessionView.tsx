import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useShallow } from 'zustand/react/shallow'

import { AudioDevicePicker } from '@/components/AudioDevicePicker'
import { AuditLogPanel, type AuditLogEntry } from '@/components/AuditLogPanel'
import type { FocusState } from '@/components/FocusIndicator'
import { SelfWarningBadge } from '@/components/SelfWarningBadge'
import { SessionEndedSplash } from '@/components/SessionEndedSplash'
import { SessionTimer } from '@/components/SessionTimer'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { VideoGrid } from '@/components/VideoGrid'
import { VideoTile } from '@/components/VideoTile'
import { useAlertsUiStore } from '@/features/ai/alertsUiStore'
import {
  startSampleLoop,
  useFocusStore,
  useModelStore,
  type SampleLoopHandle,
} from '@/features/ai'
import { useIdentity } from '@/features/identity'
import { signWithKeyring } from '@/lib/db/identity'
import type { PomodoroPreset } from '@/lib/pomodoro-types'
import { isMacLikePlatform } from '@/lib/utils'
import {
  buildAuditEvent,
  useAuditStore,
  verifyIncomingAuditEvent,
} from '@/stores/auditStore'
import { useIdentityStore } from '@/stores/identityStore'
import { usePomodoroStore } from '@/stores/pomodoroStore'
import { useSessionStore } from '@/stores/sessionStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { usePttStore } from '@/stores/pttStore'

import { startAiAlertDispatcher, type AiAlertDispatcher } from './aiAlerts'

import {
  AUDIT_ACTION,
  AUDIT_KIND_LABELS,
  type AuditEvent,
  type AuditEventDetail,
  type AuditEventKind,
} from './audit'
import { swapAudioInput } from './audioDevices'
import { startHelloProtocol } from './hello'
import { PTT_STATE_ACTION } from './lifecycle'
import { startPomodoroController, type PeerOrderingEntry } from './pomodoro'

const MEDIA_CONSTRAINTS: MediaStreamConstraints = { video: true, audio: true }

type PttPayload = { active: boolean }

// Composed session feature surface (DESIGN-SYSTEM.md §8.3): tiles for self +
// each peer, PTT-driven mute on the local audio track, an audit log right
// rail, a Pomodoro timer in the bottom bar, and a Leave button. Mounted
// whenever the session store reports an active or recently-ended session
// (the latter renders the SessionEndedSplash before reset() clears state).
export function SessionView() {
  const status = useSessionStore((s) => s.status)
  const room = useSessionStore((s) => s.room)
  const sessionLeave = useSessionStore((s) => s.leave)
  const sessionTopic = useSessionStore((s) => s.sessionTopic)
  const startedAt = useSessionStore((s) => s.startedAt)
  const peers = useSessionStore((s) => s.peers)
  const endedSnapshot = useSessionStore((s) => s.endedSnapshot)
  const setPeerHello = useSessionStore((s) => s.setPeerHello)
  const aiFeaturesEnabled = useSettingsStore((s) => s.values.aiFeaturesEnabled)
  const activeModelId = useModelStore((s) => s.activeModelId)
  const selfWarning = useAlertsUiStore((s) => s.selfWarning)
  const alertedPeers = useAlertsUiStore((s) => s.alertedPeers)
  const { identity } = useIdentity()
  // The hello+audit+pomodoro effect depends only on stable identity slices
  // (ed_pubkey_hex + x_pubkey_hex) so a display-name edit during a session
  // does not retear the controller. The display_name is read from the
  // singleton identity store at effect-mount time so the hello payload
  // reflects whatever name was set when we joined.
  const myEdPubkeyHex = identity?.ed_pubkey_hex ?? null
  const myXPubkeyHex = identity?.x_pubkey_hex ?? null
  const pttActive = usePttStore((s) => s.active)
  const auditEvents = useAuditStore((s) => s.events)
  // useShallow stops the hello+audit+pomodoro effect from re-firing on every
  // 5-second broadcaster tick: without it the selector returns a fresh
  // object literal each store mutation, which would re-render SessionView
  // and tear down the controller mid-session.
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
  const [activeAudioDeviceId, setActiveAudioDeviceId] = useState<string | null>(
    null
  )
  const [audioSwapping, setAudioSwapping] = useState(false)
  const localStreamRef = useRef<MediaStream | null>(null)
  const pttSendRef = useRef<((payload: PttPayload) => Promise<void[]>) | null>(
    null
  )
  // Stable refs the audit/pomodoro wiring closes over. Avoids re-creating the
  // hello/audit/pomodoro pipeline on every render (which would resend
  // hellos and reset broadcaster state).
  const emitAuditRef = useRef<
    | ((
        kind: AuditEventKind,
        detail?: AuditEventDetail,
        options?: { now?: () => number }
      ) => Promise<void>)
    | null
  >(null)
  const pomodoroStartRef = useRef<((preset: PomodoroPreset) => void) | null>(
    null
  )
  const pomodoroStopRef = useRef<(() => void) | null>(null)
  // The AI-alert dispatcher is created inside the hello+audit+pomodoro
  // effect (where `sign`, `sessionTopic`, and the audit pipeline already
  // exist) and read by the sample-loop effect through this ref. Matches
  // the existing pomodoroStartRef / emitAuditRef pattern.
  const aiAlertDispatcherRef = useRef<AiAlertDispatcher | null>(null)

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
        // Surface the OS-chosen default deviceId so the audio picker can
        // highlight it. enumerateDevices labels are only populated once
        // a getUserMedia call has succeeded, so this also unblocks the
        // picker's first render.
        const initialDeviceId =
          stream.getAudioTracks()[0]?.getSettings().deviceId ?? null
        setActiveAudioDeviceId(initialDeviceId)
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
    const offStream = room.onPeerStream((stream, peerId) => {
      setRemoteStreams((cur) => ({ ...cur, [peerId]: stream }))
      const cur = useSessionStore.getState().peers[peerId]
      if (cur) useSessionStore.getState().setPeerStream(peerId, true)
    })
    const offLeave = room.onPeerLeave((peerId) => {
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
    return () => {
      offStream()
      offLeave()
    }
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

  // Hello + audit + pomodoro pipeline. Deps are the stable string slices of
  // identity — display-name edits do not tear the controller down, because
  // hello payloads are one-shot per peer and capture display_name at
  // effect-mount time from the singleton identity store.
  useEffect(() => {
    if (!room || !myEdPubkeyHex || !myXPubkeyHex || !sessionTopic || !startedAt)
      return
    let stopped = false
    const myDisplayName =
      useIdentityStore.getState().identity?.display_name ?? ''
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

    // V2-P6 splits the audit emit into two halves so the ai_warning path
    // (local-only, never broadcast) can share the build+sign+append
    // pipeline without an `if (!shouldBroadcast)` branch deep in the
    // dispatcher. `emitAudit` is `appendLocalAudit` + broadcast.
    // Both helpers accept an optional `options.now` so callers that need
    // the audit-event `ts` to align with a sibling artifact (V2-P6's
    // dispatcher pairs an `ai_alert` audit row with a signed alert-channel
    // payload that must share the same `ts`) can pin the timestamp.
    // Default is `Date.now` via `buildAuditEvent`.
    const appendLocalAudit = async (
      kind: AuditEventKind,
      detail: AuditEventDetail = {},
      options?: { now?: () => number }
    ) => {
      const event = await buildAuditEvent({
        sessionTopic,
        myEdPubkeyHex,
        kind,
        detail,
        sign,
        now: options?.now,
      })
      useAuditStore.getState().append(event)
    }

    const emitAudit = async (
      kind: AuditEventKind,
      detail: AuditEventDetail = {},
      options?: { now?: () => number }
    ) => {
      const event = await buildAuditEvent({
        sessionTopic,
        myEdPubkeyHex,
        kind,
        detail,
        sign,
        now: options?.now,
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
      const verified = verifyIncomingAuditEvent(data, expectedEd)
      if (!verified) return
      useAuditStore.getState().append(verified)
    })

    const dispatcher = startAiAlertDispatcher({
      room,
      sessionTopic,
      myEdPubkeyHex,
      sign,
      resolveSenderEdPubkey: (peerId) =>
        useSessionStore.getState().peers[peerId]?.edPubkeyHex ?? null,
      appendLocalAudit,
      emitAudit,
    })
    aiAlertDispatcherRef.current = dispatcher

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
      dispatcher.teardown()
      emitAuditRef.current = null
      pomodoroStartRef.current = null
      pomodoroStopRef.current = null
      aiAlertDispatcherRef.current = null
    }
  }, [room, myEdPubkeyHex, myXPubkeyHex, sessionTopic, startedAt, setPeerHello])

  // V2-P5 focus-score reset: fires exactly once per session start, keyed on
  // startedAt rather than the sample-loop effect's deps. Without this split,
  // an in-session AI-features toggle flap or activeModelId change would
  // wipe the user's current score. V2-P6 also resets the alerts-UI store
  // here so stale self-warnings / alerted-peer entries don't bleed into the
  // next session.
  useEffect(() => {
    if (status !== 'active' || !startedAt) return
    useFocusStore.getState().reset()
    useAlertsUiStore.getState().reset()
  }, [status, startedAt])

  // V2-P5 AI sample loop: starts when AI features are on, an active model
  // exists, the session is running, and the local camera track is up.
  // Stops on any of those flipping. Topic defaults to "Studying" — V2-P9
  // replaces this with the user's required session-start input.
  useEffect(() => {
    if (status !== 'active') return
    if (!aiFeaturesEnabled) return
    if (!activeModelId) return
    if (!localStream) return
    let handle: SampleLoopHandle | null = startSampleLoop({
      topic: 'Studying',
      modelId: activeModelId,
      getFaceTrack: () => localStreamRef.current?.getVideoTracks()[0] ?? null,
      onScoreEvents: async (events, judgment) => {
        // V2-P6: route every sample's emitted events through the alert
        // dispatcher (warnings → local-only badge + ai_warning audit;
        // alerts → ai_alert audit + signed broadcast + tile highlight).
        // The dispatcher is owned by the hello/audit/pomodoro effect; the
        // ref pattern matches `emitAuditRef` / `pomodoroStartRef`.
        const dispatcher = aiAlertDispatcherRef.current
        if (!dispatcher) return
        await dispatcher.handleScoreEvents(events)
        dispatcher.handleSeverity(judgment.severity)
      },
      onStartFail: (reason, detail) => {
        if (reason === 'no_active_model') {
          toast.error('Pick a model in Settings → AI')
        } else if (reason === 'model_files_missing') {
          toast.error('Model files missing — re-download in Settings → AI')
        } else {
          toast.error(
            detail ? `AI failed to start: ${detail}` : 'AI failed to start'
          )
        }
      },
      onCaptureDenied: () => {
        toast.error('Screen recording denied — enable it in Settings → AI')
      },
      onCaptureError: (err) => {
        toast.error(`AI capture error: ${err.message}`)
      },
      onSidecarErrored: (lastError) => {
        toast.error(
          lastError
            ? `AI model crashed (${lastError}) — restart in Settings → AI`
            : 'AI model crashed — restart in Settings → AI'
        )
      },
    })
    return () => {
      const local = handle
      handle = null
      void local?.stop()
    }
  }, [status, aiFeaturesEnabled, activeModelId, localStream])

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

  // ESC-to-leave during an active session. We don't trigger on 'ended'
  // because the splash teardown is already in flight. Native-DOM listener
  // (not a Radix Dialog) so it works regardless of whether a popover is
  // open — the audit panel + footer are the focus owners 99% of the time.
  useEffect(() => {
    if (status !== 'active') return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // Avoid stealing ESC from input fields (none today, but the AI dialog
      // window in V2-P7 might mount inside this same view).
      const target = e.target as HTMLElement | null
      const tag = target?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) {
        return
      }
      e.preventDefault()
      handleLeave()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [status, handleLeave])

  const handleSwapAudioDevice = useCallback(
    async (nextDeviceId: string) => {
      const stream = localStreamRef.current
      if (!stream || audioSwapping) return
      setAudioSwapping(true)
      try {
        await swapAudioInput(
          nextDeviceId,
          {
            getUserMedia: (constraints) =>
              navigator.mediaDevices.getUserMedia(constraints),
            room,
            localStream: stream,
          },
          usePttStore.getState().active
        )
        setActiveAudioDeviceId(nextDeviceId)
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'could not switch microphone'
        toast.error(message)
      } finally {
        setAudioSwapping(false)
      }
    },
    [audioSwapping, room]
  )

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

  const myEdPubkey = identity?.ed_pubkey_hex ?? null
  const selfTileState: FocusState | undefined = myEdPubkey
    ? myEdPubkey in alertedPeers
      ? 'alerted'
      : selfWarning
        ? 'warning'
        : 'focused'
    : selfWarning
      ? 'warning'
      : 'focused'
  const selfAlertReasoning = myEdPubkey
    ? (alertedPeers[myEdPubkey]?.reasoning ?? undefined)
    : undefined

  if (status === 'ended' && endedSnapshot) {
    return (
      <SessionEndedSplash
        durationSeconds={endedSnapshot.durationSeconds}
        peerNames={endedSnapshot.peerNames}
      />
    )
  }
  if (!room) return null

  const peerEntries = Object.values(peers)
  const youName = identity?.display_name?.trim() || 'You'
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
            <div
              role="alert"
              aria-live="assertive"
              className="mb-4 rounded-md border border-status-alerted bg-bg-surface px-4 py-3 text-sm text-status-alerted"
            >
              Couldn't access camera or microphone: {mediaError}
            </div>
          ) : null}
          <VideoGrid>
            <VideoTile
              key="local"
              name={youName}
              stream={localStream}
              ptt={pttActive}
              isLocal
              state={selfTileState}
              alertReasoning={selfAlertReasoning}
            />
            {peerEntries.map((peer) => {
              const peerAlert = peer.edPubkeyHex
                ? alertedPeers[peer.edPubkeyHex]
                : undefined
              return (
                <VideoTile
                  key={peer.peerId}
                  name={peer.displayName ?? peerLabel(peer.peerId)}
                  stream={remoteStreams[peer.peerId] ?? null}
                  ptt={peerPtt[peer.peerId] ?? false}
                  state={peerAlert ? 'alerted' : 'focused'}
                  alertReasoning={peerAlert?.reasoning}
                />
              )
            })}
          </VideoGrid>
        </div>
        <AuditLogPanel events={auditEntries} />
      </div>
      <footer className="flex items-center justify-between gap-4 border-t border-border-subtle bg-bg-surface px-6 py-4 text-sm">
        <span className="flex items-center gap-3 text-text-secondary">
          <span className="flex items-center gap-2">
            hold <Kbd>{isMacLikePlatform() ? '⌘[' : 'Ctrl+['}</Kbd> to talk
          </span>
          <AudioDevicePicker
            currentDeviceId={activeAudioDeviceId}
            onSelect={handleSwapAudioDevice}
            swapping={audioSwapping}
          />
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
        </span>
        <Button
          variant="secondary"
          size="sm"
          onClick={handleLeave}
          aria-keyshortcuts="Escape"
        >
          Leave
        </Button>
      </footer>
      {selfWarning ? (
        <SelfWarningBadge reasoning={selfWarning.reasoning} />
      ) : null}
    </main>
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
    detail: AuditEventDetail
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
  return events.map((e) => {
    let hoverDetail: string | undefined
    if (e.kind === 'ai_warning' || e.kind === 'ai_alert') {
      const reasoning = e.detail?.reasoning
      if (typeof reasoning === 'string' && reasoning.length > 0) {
        hoverDetail = reasoning
      }
    }
    return {
      seq: e.seq,
      name: byEdPubkey.get(e.who) ?? `Peer ${e.who.slice(0, 6)}`,
      description: AUDIT_KIND_LABELS[e.kind],
      ts: e.ts,
      hoverDetail,
    }
  })
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
