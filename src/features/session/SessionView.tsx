import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { emitTo, listen } from '@tauri-apps/api/event'
import { toast } from 'sonner'
import { useShallow } from 'zustand/react/shallow'

import { AiStatusChip, type AiStatus } from '@/components/AiStatusChip'
import { AudioDevicePicker } from '@/components/AudioDevicePicker'
import { AuditLogPanel, type AuditLogEntry } from '@/components/AuditLogPanel'
import { BreakCountdownBadge } from '@/components/BreakCountdownBadge'
import type { FocusState } from '@/components/FocusIndicator'
import { MediaErrorBanner } from '@/components/MediaErrorBanner'
import { ScreenCapturePermissionOverlay } from '@/components/ScreenCapturePermissionOverlay'
import { SelfWarningBadge } from '@/components/SelfWarningBadge'
import { SessionTimer } from '@/components/SessionTimer'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { VideoGrid } from '@/components/VideoGrid'
import { VideoTile } from '@/components/VideoTile'
import { useAlertsUiStore } from '@/features/ai/alertsUiStore'
import {
  AI_DIALOG_BREAK_REQUEST,
  AI_DIALOG_BREAK_RESPONSE,
  AI_DIALOG_CONTEXT,
  AI_DIALOG_CONTEXT_REQUEST,
  AI_DIALOG_TOPIC_CHANGE,
  AI_DIALOG_WINDOW_LABEL,
  CaptureError,
  requestScreenCapturePermission,
  startSampleLoop,
  useBreakStore,
  useFocusStore,
  useModelStore,
  type AiDialogBreakRequestPayload,
  type AiDialogContextPayload,
  type AiDialogTopicChangePayload,
  type BreakResponsePayload,
  type SampleLoopHandle,
} from '@/features/ai'
import { useIdentity } from '@/features/identity'
import { signWithKeyring } from '@/lib/db/identity'
import type { PomodoroPreset } from '@/lib/pomodoro-types'
import { mediaErrorKind } from '@/lib/mediaError'
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
import { strings } from '@/strings'

import { startAiAlertDispatcher, type AiAlertDispatcher } from './aiAlerts'

import {
  cancelActiveBreakTimer,
  requestBreak,
  snapshotBreakState,
} from './break'

import { ESC_LEAVE_WINDOW_MS, shouldLeaveOnEsc } from './escLeave'

import {
  AUDIT_ACTION,
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
// only while the session store reports an active session — Home.tsx
// switches to the V2-P8 Report view as soon as status flips to 'ended'.
export function SessionView() {
  const status = useSessionStore((s) => s.status)
  const room = useSessionStore((s) => s.room)
  const sessionLeave = useSessionStore((s) => s.leave)
  const sessionTopic = useSessionStore((s) => s.sessionTopic)
  const startedAt = useSessionStore((s) => s.startedAt)
  const peers = useSessionStore((s) => s.peers)
  const setPeerHello = useSessionStore((s) => s.setPeerHello)
  const aiFeaturesEnabled = useSettingsStore((s) => s.values.aiFeaturesEnabled)
  const activeModelId = useModelStore((s) => s.activeModelId)
  const selfWarning = useAlertsUiStore((s) => s.selfWarning)
  const alertedPeers = useAlertsUiStore((s) => s.alertedPeers)
  const onBreak = useBreakStore((s) => s.onBreak)
  const breakEndsAt = useBreakStore((s) => s.breakEndsAt)
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
  // Holds the failed getUserMedia DOMException `name` (e.g.
  // 'NotAllowedError'), not the raw message — MediaErrorBanner maps the
  // name to calm, specific copy. Bumping mediaRetryNonce re-runs the
  // acquisition effect when the user clicks "Try again".
  const [mediaErrorName, setMediaErrorName] = useState<string | null>(null)
  const [mediaRetryNonce, setMediaRetryNonce] = useState(0)
  const [remoteStreams, setRemoteStreams] = useState<
    Record<string, MediaStream>
  >({})
  const [peerPtt, setPeerPtt] = useState<Record<string, boolean>>({})
  const [activeAudioDeviceId, setActiveAudioDeviceId] = useState<string | null>(
    null
  )
  const [audioSwapping, setAudioSwapping] = useState(false)
  // V2-P9 (V2-P5 carry-forward): the long-lived screen acquire latches the
  // loop dead on denial / "Stop sharing". Mount the permission overlay; a
  // successful retry resets focus and clears this flag, which is in the
  // sample-loop effect's deps so the loop remounts and resumes.
  const [captureDenied, setCaptureDenied] = useState(false)
  // Overlay visibility is separate from the loop latch: "Not now" closes the
  // overlay but leaves the loop dead for this session; only a successful
  // retry clears `captureDenied` and remounts the loop.
  const [captureOverlayOpen, setCaptureOverlayOpen] = useState(false)
  // Persistent AI-runtime status for the footer chip. The sample-loop
  // callbacks below set this alongside their existing toasts so "is the
  // camera being analyzed?" is answerable at a glance, not only from a
  // transient toast. The off/active distinction is derived from
  // aiFeaturesEnabled + activeModelId + localStream; this state only tracks
  // the paused/error/resumed transitions within a running loop.
  const [aiRuntimeStatus, setAiRuntimeStatus] = useState<AiStatus>('active')
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
  // Local-only audit append. V2-P6 added the split (warning path needs
  // local-only); V2-P7's break_request audit row is also local-only (the
  // user's intent is private until the verdict resolves).
  const appendLocalAuditRef = useRef<
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

  // Two-tap Esc-to-leave: the timestamp of the last "armed" Esc. A ref
  // (not state) so updating it never re-attaches the keydown listener.
  const escLeaveArmedAtRef = useRef<number | null>(null)

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
        if (cancelled) return
        // Read `.name` off the rejection directly: getUserMedia rejects with
        // a DOMException, and OverconstrainedError isn't an `instanceof Error`
        // in every engine — gating on Error would drop that branch.
        const name =
          typeof err === 'object' && err !== null && 'name' in err
            ? String((err as { name: unknown }).name)
            : ''
        setMediaErrorName(name)
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
  }, [room, mediaRetryNonce])

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
    appendLocalAuditRef.current = appendLocalAudit

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
      // Drop a (signed, valid) event addressed to a different session —
      // mirrors the ai-alert path's replay guard (aiAlerts.ts). (I8)
      if (verified.session_topic !== sessionTopic) return
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
      // V2-P9 — the only producer of `topic_set` (kind+label wired in V2-P7,
      // no producer until now). Fires once per session, only when AI is on
      // (the required topic prompt only runs in that case), right after
      // `joined` so the report's topic timeline anchors correctly. Reads the
      // one-shot initialDeclaredTopic that `begin()` seeded from the gate.
      if (useSettingsStore.getState().values.aiFeaturesEnabled) {
        const topic = useSessionStore.getState().initialDeclaredTopic
        void emitAudit('topic_set', { topic })
      }
    })()

    return () => {
      stopped = true
      controller.teardown()
      helloHandle.teardown()
      dispatcher.teardown()
      emitAuditRef.current = null
      appendLocalAuditRef.current = null
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
  // next session. V2-P7 added the break store reset; V2-P8 adds audit +
  // pomodoro to cover the invite-while-on-report path (user clicks an
  // invite from the post-session report → new session begins without
  // ever firing the Report's Close handler).
  useEffect(() => {
    if (status !== 'active' || !startedAt) return
    useFocusStore.getState().reset()
    useAlertsUiStore.getState().reset()
    useBreakStore.getState().reset(startedAt)
    useAuditStore.getState().reset()
    usePomodoroStore.getState().reset()
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot per-session reset of the AI-runtime latch, keyed on startedAt alongside the store resets above; idempotent on re-run
    setAiRuntimeStatus('active')
    return () => {
      cancelActiveBreakTimer((handle) => window.clearTimeout(handle as number))
    }
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
    // Don't relaunch into a denied state — the overlay's retry clears this.
    if (captureDenied) return
    let handle: SampleLoopHandle | null = startSampleLoop({
      getTopic: () => useSessionStore.getState().declaredStudyTopic,
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
          toast.error(strings.session.errors.pickModel)
        } else if (reason === 'model_files_missing') {
          toast.error(strings.session.errors.modelFilesMissing)
        } else {
          toast.error(
            detail
              ? strings.session.errors.aiFailedToStartDetail(detail)
              : strings.session.errors.aiFailedToStart
          )
        }
      },
      onCaptureDenied: () => {
        // Latched dead: surface the actionable overlay (retry re-grants +
        // resumes) rather than a dead-end toast.
        setCaptureDenied(true)
        setCaptureOverlayOpen(true)
        setAiRuntimeStatus('error')
      },
      onCaptureError: (err) => {
        toast.error(strings.session.errors.aiCaptureError(err.message))
      },
      onSidecarErrored: (lastError) => {
        toast.error(
          lastError
            ? strings.session.errors.aiCrashedDetail(lastError)
            : strings.session.errors.aiCrashed
        )
        setAiRuntimeStatus('error')
      },
      onBatteryPause: (info) => {
        toast.warning(strings.session.errors.aiPausedForBattery(info.percent))
        setAiRuntimeStatus('paused')
      },
      onBatteryResume: () => {
        toast.success(strings.session.errors.aiResumed)
        setAiRuntimeStatus('active')
      },
    })
    return () => {
      const local = handle
      handle = null
      void local?.stop()
    }
  }, [status, aiFeaturesEnabled, activeModelId, localStream, captureDenied])

  // V2-P7 — listen for cross-window events from the Ctrl+] AI dialog. The
  // dialog runs in a separate Tauri WebviewWindow (label = AI_DIALOG_
  // WINDOW_LABEL) and never touches the main window's stores directly. The
  // protocol is:
  //   - context-request → main replies with the current session snapshot
  //     (declared topic, active model id, recent audit kinds). Mirrors
  //     work the AI agent needs to build its chat-completion request.
  //   - topic-change    → main updates declaredStudyTopic + emits the
  //     broadcast `topic_change` audit row. Then re-emits context so the
  //     dialog's next submit uses the fresh value.
  //   - break-request   → main runs the rule layer in features/session/
  //     break.ts, emits the break_request (LOCAL-only) audit row, then
  //     either break_approved or break_denied (both broadcast). Replies
  //     to the dialog with the verdict; the dialog renders it.
  useEffect(() => {
    if (status !== 'active' || !room || !sessionTopic || !startedAt) return
    let cancelled = false
    const unlistens: Array<() => void> = []

    const buildContextSnapshot = (): AiDialogContextPayload => {
      const auditEvents = useAuditStore.getState().events
      const recentAuditKinds = auditEvents
        .slice(-8)
        .map((e) => e.kind)
        .reverse()
      return {
        declaredTopic: useSessionStore.getState().declaredStudyTopic,
        modelId: useModelStore.getState().activeModelId ?? '',
        recentAuditKinds,
      }
    }

    // Register a listener with cancellation-safety: if the effect already
    // tore down by the time `listen()` resolves, we MUST call the returned
    // unlisten ourselves — pushing it into `unlistens` after the cleanup
    // ran would leak the subscription.
    const registerListener = async <T,>(
      eventName: string,
      handler: (payload: T) => void
    ): Promise<void> => {
      const off = await listen<T>(eventName, (event) => {
        if (cancelled) return
        handler(event.payload)
      })
      if (cancelled) {
        off()
        return
      }
      unlistens.push(off)
    }

    const emitToDialog = (event: string, payload: unknown): void => {
      // The dialog window may have been closed between request and
      // response; emitTo rejects in that case. Swallow the rejection so
      // it doesn't surface as an unhandled promise rejection.
      void emitTo(AI_DIALOG_WINDOW_LABEL, event, payload).catch((err) => {
        console.warn(`[ai-dialog] emitTo(${event}) failed:`, err)
      })
    }

    void (async () => {
      await registerListener(AI_DIALOG_CONTEXT_REQUEST, () => {
        emitToDialog(AI_DIALOG_CONTEXT, buildContextSnapshot())
      })

      await registerListener<AiDialogTopicChangePayload>(
        AI_DIALOG_TOPIC_CHANGE,
        (payload) => {
          const next = payload?.new_topic?.trim()
          if (!next) return
          const previous = useSessionStore.getState().declaredStudyTopic
          if (next === previous) return
          useSessionStore.getState().setDeclaredStudyTopic(next)
          const emit = emitAuditRef.current
          if (emit) {
            void emit('topic_change', {
              previous_topic: previous,
              new_topic: next,
            }).catch((err) => {
              console.error('[ai-dialog] topic_change audit failed:', err)
            })
          }
          // Re-push context so a still-open dialog reflects the new value.
          emitToDialog(AI_DIALOG_CONTEXT, buildContextSnapshot())
        }
      )

      await registerListener<AiDialogBreakRequestPayload>(
        AI_DIALOG_BREAK_REQUEST,
        (payload) => {
          if (!payload?.nonce) return
          const emit = emitAuditRef.current
          const append = appendLocalAuditRef.current
          if (!emit || !append) {
            emitToDialog(AI_DIALOG_BREAK_RESPONSE, {
              nonce: payload.nonce,
              verdict: 'denied',
              reason: 'session not ready',
            } satisfies BreakResponsePayload)
            return
          }
          void requestBreak(
            {
              requestedDurationSec: payload.requested_duration_sec,
              aiRecommendation: payload.ai_recommendation,
              aiReasoning: payload.ai_reasoning,
              now: Date.now(),
            },
            {
              appendLocalAudit: append,
              emitAudit: emit,
              startApprovedBreak: ({ durationSec, startedAt: at }) =>
                useBreakStore
                  .getState()
                  .startApprovedBreak({ durationSec, startedAt: at }),
              endBreak: (endedAt) => useBreakStore.getState().endBreak(endedAt),
              setTimeout: (handler, ms) => window.setTimeout(handler, ms),
              clearTimeout: (handle) => window.clearTimeout(handle as number),
              snapshot: snapshotBreakState,
              now: () => Date.now(),
            }
          )
            .then((verdict) => {
              const response: BreakResponsePayload =
                verdict.verdict === 'approved'
                  ? {
                      nonce: payload.nonce,
                      verdict: 'approved',
                      reason: verdict.reason,
                      duration_sec: verdict.durationSec,
                    }
                  : {
                      nonce: payload.nonce,
                      verdict: 'denied',
                      reason: verdict.reason,
                    }
              emitToDialog(AI_DIALOG_BREAK_RESPONSE, response)
            })
            .catch((err) => {
              console.error('[ai-dialog] break flow failed:', err)
              emitToDialog(AI_DIALOG_BREAK_RESPONSE, {
                nonce: payload.nonce,
                verdict: 'denied',
                reason: err instanceof Error ? err.message : 'unexpected error',
              } satisfies BreakResponsePayload)
            })
        }
      )
    })()

    return () => {
      cancelled = true
      for (const off of unlistens) off()
    }
  }, [status, room, sessionTopic, startedAt])

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
        const message =
          err instanceof Error
            ? err.message
            : strings.session.errors.leaveFailedFallback
        toast.error(message)
      }
    })()
  }, [sessionLeave])

  // ESC-to-leave during an active session. We don't trigger on 'ended'
  // because the splash teardown is already in flight. Native-DOM listener
  // (not a Radix Dialog) so it works regardless of whether a popover is
  // open — the audit panel + footer are the focus owners 99% of the time.
  // Leaving is irreversible, so a single Esc only arms: a second Esc inside
  // ESC_LEAVE_WINDOW_MS leaves; otherwise it re-arms.
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
      const now = Date.now()
      if (
        shouldLeaveOnEsc(escLeaveArmedAtRef.current, now, ESC_LEAVE_WINDOW_MS)
      ) {
        escLeaveArmedAtRef.current = null
        toast.dismiss('esc-leave-hint')
        handleLeave()
        return
      }
      escLeaveArmedAtRef.current = now
      toast(strings.session.escLeaveHint, {
        id: 'esc-leave-hint',
        duration: ESC_LEAVE_WINDOW_MS,
      })
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
          err instanceof Error
            ? err.message
            : strings.session.errors.switchMicFailedFallback
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

  // "Try again" — clear the error and bump the nonce so the acquisition
  // effect (keyed on [room, mediaRetryNonce]) re-runs getUserMedia.
  const handleMediaRetry = useCallback(() => {
    setMediaErrorName(null)
    setMediaRetryNonce((n) => n + 1)
  }, [])

  // Only offered for the permission-denied case. Jumps to the OS camera
  // privacy pane via the same Rust opener the onboarding step uses. macOS is
  // the only target with a stable deep link, matching PermissionsStep.
  const handleOpenMediaSettings = useCallback(() => {
    void (async () => {
      try {
        await invoke('system_open_camera_settings')
      } catch {
        toast.error(strings.onboarding.permissions.openSettingsErrorFallback)
      }
    })()
  }, [])

  // V2-P5 carry-forward: re-grant + resume after a mid-session screen-capture
  // denial. The overlay closes itself before calling this; on success we
  // reset the focus score (the dead loop's last samples shouldn't count) and
  // clear the latch, which is in the sample-loop effect deps so it remounts.
  const handleCaptureRetry = useCallback(() => {
    void (async () => {
      try {
        await requestScreenCapturePermission()
        useFocusStore.getState().reset()
        setCaptureDenied(false)
        setAiRuntimeStatus('active')
      } catch (err) {
        if (
          err instanceof CaptureError &&
          err.code === 'screen_capture_denied'
        ) {
          setCaptureOverlayOpen(true)
          return
        }
        toast.error(
          err instanceof Error
            ? err.message
            : strings.session.errors.requestAccessFallback
        )
      }
    })()
  }, [])

  const elapsed = useElapsed(startedAt)
  const auditEntries = useMemo(
    () => mapAuditEntries(auditEvents, identity, peers),
    [auditEvents, identity, peers]
  )

  const myEdPubkey = identity?.ed_pubkey_hex ?? null
  // Per-tile state computation. Always defer to the VideoTile fallback
  // (`stream ? 'online' : 'offline'`) when there's no positive UI signal
  // — passing 'focused' while the stream is still null (or AI off) would
  // claim an "on task" verdict that doesn't exist yet. Order matches the
  // V2-P5 spec: alerted > warning > focused, with focused only when AI
  // is on AND we have a stream.
  const selfTileState: FocusState | undefined = !localStream
    ? undefined
    : myEdPubkey && myEdPubkey in alertedPeers
      ? 'alerted'
      : selfWarning
        ? 'warning'
        : aiFeaturesEnabled
          ? 'focused'
          : undefined
  const selfAlertReasoning = myEdPubkey
    ? (alertedPeers[myEdPubkey]?.reasoning ?? undefined)
    : undefined

  // The off-check wins over the runtime status so a stale 'error'/'paused'
  // from a prior loop never lies once AI is disabled, the model is cleared,
  // or the camera track drops. Otherwise the runtime state (set by the
  // sample-loop callbacks) is the truth for the running loop.
  const aiChipStatus: AiStatus =
    !aiFeaturesEnabled || !activeModelId || !localStream
      ? 'off'
      : aiRuntimeStatus

  if (!room) return null

  const peerEntries = Object.values(peers)
  const youName = identity?.display_name?.trim() || strings.session.selfFallback
  const broadcasterName = pomodoroSnapshot.iAmBroadcaster
    ? strings.session.broadcasterSelf
    : pomodoroSnapshot.broadcasterEdPubkey
      ? (peerEntries.find(
          (p) => p.edPubkeyHex === pomodoroSnapshot.broadcasterEdPubkey
        )?.displayName ?? null)
      : null

  return (
    <main
      className="flex min-h-screen flex-col bg-bg-base text-text-primary"
      aria-label={strings.session.mainAriaLabel}
    >
      {/* V3-P7 — Visually-hidden top-level heading so SR users have a clean
          one-h1-per-route anchor. The visible UI is the video grid + audit
          panel + footer; none of those would carry "the page title" on their
          own. */}
      <h1 className="sr-only">{strings.app.sessionSrHeading}</h1>
      <div className="flex min-h-0 flex-1">
        <div className="flex-1 px-6 py-6">
          {mediaErrorName !== null ? (
            <MediaErrorBanner
              errorName={mediaErrorName}
              onRetry={handleMediaRetry}
              onOpenSettings={
                mediaErrorKind(mediaErrorName) === 'denied' &&
                isMacLikePlatform()
                  ? handleOpenMediaSettings
                  : undefined
              }
            />
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
              const peerStream = remoteStreams[peer.peerId] ?? null
              const peerAlert = peer.edPubkeyHex
                ? alertedPeers[peer.edPubkeyHex]
                : undefined
              // Peer state: alerted iff they broadcast an alert (works
              // regardless of OUR aiFeaturesEnabled — the data channel is
              // always wired). Otherwise defer to the tile's stream-based
              // fallback so a peer whose tracks haven't arrived shows
              // `offline` rather than claiming an `on task` verdict we
              // don't actually have.
              const peerState: FocusState | undefined = !peerStream
                ? undefined
                : peerAlert
                  ? 'alerted'
                  : undefined
              return (
                <VideoTile
                  key={peer.peerId}
                  name={peer.displayName ?? peerLabel(peer.peerId)}
                  stream={peerStream}
                  ptt={peerPtt[peer.peerId] ?? false}
                  state={peerState}
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
            {strings.session.footerHoldBefore}
            <Kbd>{isMacLikePlatform() ? '⌘[' : 'Ctrl+['}</Kbd>
            {strings.session.footerHoldAfter}
          </span>
          <AudioDevicePicker
            currentDeviceId={activeAudioDeviceId}
            onSelect={handleSwapAudioDevice}
            swapping={audioSwapping}
          />
        </span>
        <span className="flex items-center gap-4">
          <AiStatusChip status={aiChipStatus} />
          <span
            role="img"
            className="flex items-center gap-1.5 text-text-secondary"
            aria-label={strings.session.elapsed.ariaLabel(elapsed)}
          >
            <span aria-hidden="true">{strings.session.elapsed.label}</span>
            <span className="font-mono tabular-nums" aria-hidden="true">
              {elapsed}
            </span>
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
          {strings.session.leaveCta}
        </Button>
      </footer>
      {selfWarning && !onBreak ? (
        <SelfWarningBadge reasoning={selfWarning.reasoning} />
      ) : null}
      {onBreak ? <BreakCountdownBadge endsAt={breakEndsAt} /> : null}
      <ScreenCapturePermissionOverlay
        open={captureOverlayOpen}
        onOpenChange={setCaptureOverlayOpen}
        onRetry={handleCaptureRetry}
      />
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
  return strings.session.peerFallback(peerId)
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
  return events.map((e) => ({
    seq: e.seq,
    name: byEdPubkey.get(e.who) ?? strings.session.peerFallback(e.who),
    description: strings.audit.kindLabels[e.kind],
    ts: e.ts,
    hoverDetail: hoverDetailFor(e.kind, e.detail),
    iconKind: e.kind,
  }))
}

// Maps each audit kind to the detail field that should surface on hover.
// V2-P6 covered ai_warning / ai_alert via `detail.reasoning`; V2-P8
// extends the same pattern to the V2-P7 break + topic kinds so the user
// sees the "why" / "what changed" without paying for a permanent slot in
// the row. Unknown / detail-less kinds return undefined and the row
// renders without a title attribute.
function hoverDetailFor(
  kind: AuditEventKind,
  detail: AuditEventDetail
): string | undefined {
  switch (kind) {
    case 'ai_warning':
    case 'ai_alert': {
      const reasoning = detail?.reasoning
      return typeof reasoning === 'string' && reasoning.length > 0
        ? reasoning
        : undefined
    }
    case 'topic_change': {
      const prev = detail?.previous_topic
      const next = detail?.new_topic
      if (typeof prev === 'string' && typeof next === 'string') {
        return `${prev} → ${next}`
      }
      return undefined
    }
    case 'topic_set': {
      const topic = detail?.topic
      return typeof topic === 'string' && topic.length > 0 ? topic : undefined
    }
    case 'break_request': {
      const requested = detail?.requested_duration_sec
      const aiReason = detail?.ai_reasoning
      const parts: string[] = []
      if (typeof requested === 'number' && Number.isFinite(requested)) {
        const minutes = Math.max(0, Math.round(requested / 60))
        parts.push(`requested ${minutes} min`)
      }
      if (typeof aiReason === 'string' && aiReason.length > 0) {
        parts.push(aiReason)
      }
      return parts.length > 0 ? parts.join(' · ') : undefined
    }
    case 'break_approved':
    case 'break_denied': {
      const reason = detail?.reason
      return typeof reason === 'string' && reason.length > 0
        ? reason
        : undefined
    }
    default:
      return undefined
  }
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
