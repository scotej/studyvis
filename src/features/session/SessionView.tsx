import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { emitTo, listen } from '@tauri-apps/api/event'
import {
  ScreenShareIcon,
  ScreenShareOffIcon,
  Settings2Icon,
  UserPlusIcon,
  VideoIcon,
  VideoOffIcon,
} from 'lucide-react'
import { toast } from 'sonner'
import { useShallow } from 'zustand/react/shallow'

import { AiStatusChip, type AiStatus } from '@/components/AiStatusChip'
import { AudioDevicePicker } from '@/components/AudioDevicePicker'
import { AudioOutputPicker } from '@/components/AudioOutputPicker'
import { AuditLogPanel, type AuditLogEntry } from '@/components/AuditLogPanel'
import { BreakCountdownBadge } from '@/components/BreakCountdownBadge'
import type { FocusState } from '@/components/FocusIndicator'
import { MediaErrorBanner } from '@/components/MediaErrorBanner'
import { ScreenCapturePermissionOverlay } from '@/components/ScreenCapturePermissionOverlay'
import { ScreenShareViewer } from '@/components/ScreenShareViewer'
import { SelfWarningBadge } from '@/components/SelfWarningBadge'
import { SessionTimer } from '@/components/SessionTimer'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { VideoGrid } from '@/components/VideoGrid'
import { VideoTile } from '@/components/VideoTile'
import { WaitingTile } from '@/components/WaitingTile'
import { useAlertsUiStore } from '@/features/ai/alertsUiStore'
import {
  AI_DIALOG_BREAK_REQUEST,
  AI_DIALOG_BREAK_RESPONSE,
  AI_DIALOG_CONTEXT,
  AI_DIALOG_CONTEXT_REQUEST,
  AI_DIALOG_TOPIC_CHANGE,
  AI_DIALOG_WINDOW_LABEL,
  discardPendingScreenStream,
  ERR_ENGINE_NOT_INSTALLED,
  isUncertainVerdict,
  preacquireScreenStream,
  startSampleLoop,
  useBreakStore,
  useFocusStore,
  useModelStore,
  type AiDialogBreakRequestPayload,
  type AiDialogContextPayload,
  type AiDialogTopicChangePayload,
  type BreakResponsePayload,
  type SampleBlockReason,
  type SampleLoopHandle,
} from '@/features/ai'
import { tokens } from '@/design/tokens'
import { isOnline, type PresenceMap } from '@/features/friends/presence'
import { useIdentity } from '@/features/identity'
import type { SettingsCategoryId } from '@/features/settings'
import type { Friend } from '@/lib/db/friends'
import { signWithKeyring } from '@/lib/db/identity'
import { mediaErrorKind } from '@/lib/mediaError'
import {
  comboToInlineDisplay,
  DEFAULT_PTT_FRIENDS_COMBO,
  parseAccelerator,
} from '@/lib/keybindings'
import { isMacLikePlatform } from '@/lib/utils'
import {
  buildAuditEvent,
  useAuditStore,
  verifyIncomingAuditEvent,
} from '@/stores/auditStore'
import { useFriendsStore } from '@/stores/friendsStore'
import { useIdentityStore } from '@/stores/identityStore'
import { usePomodoroStore } from '@/stores/pomodoroStore'
import { useSessionStore } from '@/stores/sessionStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { usePttStore } from '@/stores/pttStore'
import { strings } from '@/strings'

import { startAiAlertDispatcher, type AiAlertDispatcher } from './aiAlerts'
import { deriveAiChipStatus } from './aiChip'

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
import {
  CAMERA_STATE_ACTION,
  connectionFocusState,
  MAX_REMOTE_PEERS,
  PTT_STATE_ACTION,
  publishLocalStream,
} from './lifecycle'
import { SessionInviteDialog } from './SessionInviteDialog'
import {
  buildNotePayload,
  NOTE_ACTION,
  verifyIncomingNote,
  type NotePayload,
} from './notes'
import { useNotesStore, type SessionNote } from './notesStore'
import {
  requestScreenShareStream,
  startScreenShareController,
  type ScreenShareController,
} from './screenShare'
import { SessionNotesPanel } from './SessionNotesPanel'
import {
  startPomodoroController,
  type PeerOrderingEntry,
  type StartArgs as PomodoroStartArgs,
} from './pomodoro'
import { logger } from '@/lib/log'

const log = logger.child('session')
const dialogLog = log.child('aidialog')

// #47 B4 — honor the persisted mic pick on acquisition. `ideal` (never
// `exact`) so an unplugged/renamed device falls back to the OS default
// instead of failing the whole getUserMedia.
function mediaConstraints(
  preferredAudioDeviceId: string | null
): MediaStreamConstraints {
  return {
    video: true,
    audio: preferredAudioDeviceId
      ? { deviceId: { ideal: preferredAudioDeviceId } }
      : true,
  }
}

type PttPayload = { active: boolean }
type CameraPayload = { off: boolean }

const DEFAULT_PEER_VOLUME = 1

// #96 — key for "the screen I'm sharing" in the expanded-viewer state, which is
// otherwise keyed by peerId. trystero generates peerIds from an alphanumeric
// alphabet, so a leading '@' can never collide with one.
const LOCAL_SCREEN_KEY = '@local'

// I82 — copy for the "AI hasn't managed a reading" notice, one entry per
// `SampleBlockReason`. Typed as full Records so a new reason in the loop is a
// type error here rather than an `undefined` toast.
const AI_NO_READING_TOAST: Record<SampleBlockReason, string> =
  strings.session.errors.aiNoReading
const AI_NO_READING_LOG: Record<SampleBlockReason, string> =
  strings.session.errors.aiNoReadingLog

// The subset whose fix lives in Settings → AI (restart the engine, pick a
// lighter model). A missing camera frame or a stopped screen share is fixed
// in the session bar instead, so those toasts carry no settings shortcut.
const AI_ENGINE_BLOCK_REASONS = new Set<SampleBlockReason>([
  'engine_warming',
  'inference_timeout',
  'inference_failed',
])

// Composed session feature surface (DESIGN-SYSTEM.md §8.3): tiles for self +
// each peer, PTT-driven mute on the local audio track, an audit log right
// rail, a Pomodoro timer in the bottom bar, and a Leave button. Mounted
// only while the session store reports an active session — Home.tsx
// switches to the V2-P8 Report view as soon as status flips to 'ended'.
export type SessionViewProps = {
  // #47 A2 — presence + invite sender injected by Home so the host can grow
  // a live session toward the 4-user mesh. Both omitted in tests, which
  // hides the invite affordance entirely.
  presence?: PresenceMap
  onInviteFriend?: (friend: Friend) => void
  // #47 B2 — open the Home-hosted settings overlay (optionally deep-linked
  // to a category) WITHOUT unmounting the session. Shipped error copy sends
  // users to "Settings → AI"; before this, following it meant leaving — and
  // in a 2-person session, ending it for everyone.
  onOpenSettings?: (category?: SettingsCategoryId) => void
}

export function SessionView({
  presence,
  onInviteFriend,
  onOpenSettings,
}: SessionViewProps) {
  const status = useSessionStore((s) => s.status)
  const room = useSessionStore((s) => s.room)
  const isHost = useSessionStore((s) => s.isHost)
  const sessionLeave = useSessionStore((s) => s.leave)
  const sessionTopic = useSessionStore((s) => s.sessionTopic)
  const startedAt = useSessionStore((s) => s.startedAt)
  const startedAtMono = useSessionStore((s) => s.startedAtMono)
  const peers = useSessionStore((s) => s.peers)
  const setPeerHello = useSessionStore((s) => s.setPeerHello)
  const seenPeerNames = useSessionStore((s) => s.seenPeerNames)
  // U2×S1 — whether a friend has ever been admitted this session, so the
  // alone-tile shows invite copy on a never-had-peers start vs reconnect copy
  // when everyone dropped (during the S1 grace window or after a leave).
  const hadAnyPeer = useSessionStore((s) => s.seenPeerEdPubkeys.length > 0)
  const aiFeaturesEnabled = useSettingsStore((s) => s.values.aiFeaturesEnabled)
  // The footer hint must show the PERSISTED binding: rebinding shipped in
  // V3-P3, and a hardcoded default lied every session to exactly the users
  // who rebound because CmdOrCtrl+[ clashed with another app.
  const pttFriendsAccelerator = useSettingsStore(
    (s) => s.values.pttFriendsAccelerator
  )
  const pttFriendsLabel = comboToInlineDisplay(
    parseAccelerator(pttFriendsAccelerator) ?? DEFAULT_PTT_FRIENDS_COMBO,
    isMacLikePlatform() ? 'mac' : 'other'
  )
  // #47 B4 — persisted per-friend volumes (ed_pubkey → 0..1); the fallback
  // when this session hasn't touched a peer's slider yet.
  const persistedPeerVolumes = useSettingsStore((s) => s.values.peerVolumes)
  const activeModelId = useModelStore((s) => s.activeModelId)
  // I83 — distinguishes "no model picked" from "model store hasn't loaded
  // yet". Only the former is worth telling the user about.
  const modelStatus = useModelStore((s) => s.status)
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
  // #47 B6 — the ephemeral note feed + the wire sender owned by the
  // hello/audit effect (same ref pattern as emitAuditRef).
  const sessionNotes = useNotesStore((s) => s.notes)
  const sendNoteRef = useRef<((text: string) => Promise<void>) | null>(null)
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
  // F4 — per-peer RTCPeerConnection.connectionState, fed from the trystero
  // wrapper's getPeers() + a connectionstatechange subscription so a peer
  // mid-ICE-handshake or with a failed connection no longer reads as a frozen
  // offline tile.
  const [peerConnState, setPeerConnState] = useState<
    Record<string, RTCPeerConnectionState>
  >({})
  const [activeAudioDeviceId, setActiveAudioDeviceId] = useState<string | null>(
    null
  )
  const [audioSwapping, setAudioSwapping] = useState(false)
  // #47 A2 — mid-session invite picker (host only; see the footer button).
  const [inviteOpen, setInviteOpen] = useState(false)
  const friends = useFriendsStore((s) => s.friends)
  // #47 B2 — ref so the sample-loop effect's toast callbacks reach the
  // current opener without adding it to the effect deps (same pattern as
  // emitAuditRef): a re-render must not tear down the AI loop.
  const onOpenSettingsRef = useRef(onOpenSettings)
  useEffect(() => {
    onOpenSettingsRef.current = onOpenSettings
  })
  const aiSettingsToastAction = () => {
    const open = onOpenSettingsRef.current
    return open
      ? {
          action: {
            label: strings.session.errors.openSettingsAction,
            onClick: () => open('ai'),
          },
        }
      : undefined
  }
  // S3 — local camera on/off. Toggling flips the local video track's `enabled`
  // flag (never replaces the stream — V2-P5's focus-reset depends on a
  // monotonic localStream). When off, the AI sample loop pauses (getFaceTrack
  // would otherwise read a black frame) and the state is broadcast so peers
  // render an explicit camera-off tile.
  const [cameraOn, setCameraOn] = useState(true)
  const [peerCameraOff, setPeerCameraOff] = useState<Record<string, boolean>>(
    {}
  )
  // S4 — chosen audio OUTPUT device (null = system default) and per-peer
  // volume in [0, 1]. setSinkId is unsupported in macOS WKWebView, so the
  // picker that drives `activeOutputDeviceId` is hidden there (feature-
  // detected in AudioOutputPicker); volume is always available. #47 B4:
  // both now persist — the output pick seeds from settings and per-friend
  // volumes fall back to the ed_pubkey-keyed persisted map (a vanished
  // persisted device degrades silently: VideoTile swallows setSinkId
  // failures, so playback stays on the OS default).
  const [activeOutputDeviceId, setActiveOutputDeviceId] = useState<
    string | null
  >(() => useSettingsStore.getState().values.audioOutputDeviceId)
  const [peerVolumes, setPeerVolumes] = useState<Record<string, number>>({})
  // #96 — screen sharing. The local stream is the one we publish; the peer map
  // is fed by the controller's classifier, so a friend's screen never lands on
  // their face tile. `expandedScreen` holds the key of the screen open in the
  // full-size viewer (LOCAL_SCREEN_KEY or a peerId) — keyed rather than holding
  // the stream itself so a share that stops closes the viewer on its own.
  const [screenStream, setScreenStream] = useState<MediaStream | null>(null)
  const [peerScreenStreams, setPeerScreenStreams] = useState<
    Record<string, MediaStream>
  >({})
  const [expandedScreen, setExpandedScreen] = useState<string | null>(null)
  const screenStreamRef = useRef<MediaStream | null>(null)
  const screenShareRef = useRef<ScreenShareController | null>(null)
  const cameraSendRef = useRef<
    ((payload: CameraPayload) => Promise<void>) | null
  >(null)
  // Imperative mirror of `cameraOn` so the on-join camera-state resend reads
  // the live value without re-subscribing the action on every toggle.
  const cameraOnRef = useRef(true)
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
  // I82 — is a reported stall still outstanding? Only a resolved sample
  // (`onSamplesResumed`) clears it. Other events that would otherwise flip the
  // chip back to "AI watching" — notably the battery-pause resume, which fires
  // on the first unpaused tick without any sample having landed — must not
  // claim the loop is working again while this is true.
  const aiStalledRef = useRef(false)
  const localStreamRef = useRef<MediaStream | null>(null)
  const pttSendRef = useRef<((payload: PttPayload) => Promise<void>) | null>(
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
  const pomodoroStartRef = useRef<((args: PomodoroStartArgs) => void) | null>(
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

  // N4 — single chokepoint for the Rust SessionActiveFlag. Every teardown
  // path (Leave button, everyone-left auto-end, grace-window expiry, this
  // component unmounting, and the boot/idle reset) funnels through `status`
  // leaving 'active', so this effect's cleanup is the one place that flips the
  // flag back off. While active, a quit attempt (window close with
  // minimize-to-tray off, tray Quit, macOS Cmd+Q) is intercepted by Rust and
  // routed to QuitConfirmListener instead of dropping peers mid-session.
  useEffect(() => {
    if (status !== 'active') return
    void invoke('session_set_active', { active: true }).catch(() => {})
    return () => {
      void invoke('session_set_active', { active: false }).catch(() => {})
    }
  }, [status])

  // Capture the camera + mic once per active session and publish the resulting
  // MediaStream to the room. I77 — publishing is `publishLocalStream`, not a
  // bare `addStream`: trystero only ever delivers a stream to the peers active
  // at call time, so the host (alone in a freshly derived topic when its camera
  // opens) reached nobody. See the contract on that function.
  useEffect(() => {
    if (!room) return
    let cancelled = false
    let acquiredStream: MediaStream | null = null
    let detachTrackEnded: (() => void) | null = null
    let offJoinStream: (() => void) | null = null
    void (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia(
          mediaConstraints(
            useSettingsStore.getState().values.audioInputDeviceId
          )
        )
        if (cancelled) {
          stopTracks(stream)
          return
        }
        acquiredStream = stream
        // Default-muted unless PTT is currently held (PLAN.md §5: "Default-
        // muted; PTT key unmutes only while held."). Read the live PTT state
        // imperatively so a stream re-acquire mid-hold (e.g. clicking
        // MediaErrorBanner "Try again" while pressing the key) comes up
        // unmuted — the PTT effect only re-fires on change and would
        // otherwise leave the fresh track silently muted.
        const pttHeld = usePttStore.getState().active
        for (const t of stream.getAudioTracks()) t.enabled = pttHeld
        // S3 — a fresh track defaults to enabled; if the user re-acquires
        // (MediaErrorBanner "Try again") while the camera is toggled off, mirror
        // that state so the new video track doesn't come up live behind a
        // camera-off tile. Reads the ref so it's correct without re-running on
        // every toggle.
        for (const t of stream.getVideoTracks()) t.enabled = cameraOnRef.current
        // Recover from a mid-session device loss. A live track can end at any
        // time — camera unplugged, disabled in OS settings, privacy permission
        // revoked, or (common on Windows, where camera access is often
        // exclusive) grabbed by another app. Without this the peers see a
        // frozen tile for the rest of the session and the AI face path reads a
        // dead track, all with zero feedback. Surface the same recovery banner
        // ("Try again" re-runs getUserMedia + room.addStream) the initial
        // acquisition failure uses; 'NotReadableError' maps to the device
        // in-use / unavailable copy bucket.
        const handleTrackEnded = () => {
          if (cancelled) return
          if (localStreamRef.current !== stream) return
          setMediaErrorName('NotReadableError')
        }
        const endedTracks = stream.getTracks()
        for (const t of endedTracks) {
          t.addEventListener('ended', handleTrackEnded)
        }
        detachTrackEnded = () => {
          for (const t of endedTracks) {
            t.removeEventListener('ended', handleTrackEnded)
          }
        }
        offJoinStream = publishLocalStream(room, stream)
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
      detachTrackEnded?.()
      // Drop the join re-send BEFORE the stream dies: a "Try again"
      // (mediaRetryNonce) tears this effect down and a surviving subscriber
      // would hand a peer joining a moment later a stream whose tracks were
      // just stopped below.
      offJoinStream?.()
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

  // S2 — on a genuine session teardown (leave, auto-end, unmount) drop PTT so a
  // held key at the moment the room closes can't latch `active` across sessions.
  // Keyed on `[room]` ONLY, deliberately separate from the media-acquire effect
  // above: a "Try again" re-acquire bumps `mediaRetryNonce`, and resetting PTT
  // on that path would clobber the held state the acquire effect reads back
  // imperatively (the "mid-hold-unmuted" contract) — the fresh track would come
  // up muted even though the key is still down. Room changes only on real
  // teardown, so this fires exactly when intended.
  useEffect(() => {
    if (!room) return
    return () => {
      usePttStore.getState().reset()
    }
  }, [room])

  // Bind peer streams to per-peer state. I77 — `onPeerStream` does NOT replay:
  // trystero assigns it bare (room.mjs:511) and only `onPeerJoin` sweeps
  // already-active peers (room.mjs:506-509), a replay our wrapper consumes at
  // construction anyway. Nothing re-delivers a stream we were not subscribed
  // for, so this effect is only correct because `begin()` publishes the room
  // and `status: 'active'` in one store write — the subscriber is live one
  // commit later, long before any handshake can complete. We also drop stream
  // + PTT entries when a peer leaves
  // — this keeps cleanup inside an event callback so the lint rule against
  // "setState synchronously inside an effect body" doesn't fire.
  useEffect(() => {
    if (!room) return
    const offStream = room.onPeerStream((stream, peerId, metadata) => {
      // #96 — a sharing peer publishes a second stream on the same connection.
      // Ask the screen-share controller which tile it belongs to before binding
      // it, or the friend's face is replaced by their desktop.
      if (
        screenShareRef.current?.classify(peerId, stream, metadata) === 'screen'
      ) {
        setPeerScreenStreams((cur) => ({ ...cur, [peerId]: stream }))
        return
      }
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

  // F4 — track each peer's RTCPeerConnection.connectionState. trystero exposes
  // the live RTCPeerConnection map via getPeers(); we read the initial state
  // on join and subscribe to connectionstatechange, tearing the listener down
  // on peer-leave and on unmount. A peer's connection appears slightly after
  // onPeerJoin (the datachannel forms first), so we also re-resolve any
  // not-yet-bound peers on each join event.
  useEffect(() => {
    if (!room) return
    const subscriptions = new Map<string, () => void>()

    const bind = (peerId: string): void => {
      if (subscriptions.has(peerId)) return
      const conn = room.getPeers()[peerId]
      if (!conn) return
      const update = () => {
        setPeerConnState((cur) => ({ ...cur, [peerId]: conn.connectionState }))
      }
      conn.addEventListener('connectionstatechange', update)
      subscriptions.set(peerId, () => {
        conn.removeEventListener('connectionstatechange', update)
      })
      update()
    }

    const offJoin = room.onPeerJoin((peerId) => {
      bind(peerId)
    })
    const offLeave = room.onPeerLeave((peerId) => {
      const off = subscriptions.get(peerId)
      if (off) {
        off()
        subscriptions.delete(peerId)
      }
      setPeerConnState((cur) => {
        if (!(peerId in cur)) return cur
        const next = { ...cur }
        delete next[peerId]
        return next
      })
    })
    // Bind peers already present when this effect mounts (re-mount after an
    // HMR / dependency change).
    for (const peerId of Object.keys(room.getPeers())) bind(peerId)

    return () => {
      offJoin()
      offLeave()
      for (const off of subscriptions.values()) off()
      subscriptions.clear()
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
    // trystero actions aren't replayed to late joiners, so a peer who joins
    // while we're mid-transmit would never light our PTT indicator until we
    // re-press. Send our current state directly to each new peer on join.
    const offJoin = room.onPeerJoin((peerId) => {
      void action.send({ active: usePttStore.getState().active }, peerId)
    })
    return () => {
      offJoin()
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

  // S3 — camera-state broadcast: peers render an explicit camera-off tile
  // (a disabled video track sends black, not a clean "off" signal). Mirrors
  // the PTT broadcast wire pattern, including the on-join resend so a late
  // joiner sees our current camera state immediately.
  useEffect(() => {
    if (!room) return
    const action = room.makeAction<CameraPayload>(CAMERA_STATE_ACTION)
    cameraSendRef.current = action.send
    action.receive((data, peerId) => {
      const off = Boolean((data as CameraPayload)?.off)
      setPeerCameraOff((cur) => ({ ...cur, [peerId]: off }))
    })
    const offJoin = room.onPeerJoin((peerId) => {
      void action.send({ off: !cameraOnRef.current }, peerId)
    })
    const offLeave = room.onPeerLeave((peerId) => {
      setPeerCameraOff((cur) => {
        if (!(peerId in cur)) return cur
        const next = { ...cur }
        delete next[peerId]
        return next
      })
    })
    return () => {
      offJoin()
      offLeave()
      cameraSendRef.current = null
    }
  }, [room])

  // S3 — reflect the local camera toggle on the video track's `enabled` flag
  // (NOT a stream replace — V2-P5's focus-reset depends on a monotonic
  // localStream) and broadcast the new state to peers.
  useEffect(() => {
    cameraOnRef.current = cameraOn
    const stream = localStreamRef.current
    if (stream) {
      for (const t of stream.getVideoTracks()) t.enabled = cameraOn
    }
    const send = cameraSendRef.current
    if (send) void send({ off: !cameraOn })
  }, [cameraOn])

  // #96 — screen-share controller. Owns the `screen-share` announce channel,
  // the capability gate that keeps a pre-1.9 peer from being handed a second
  // stream it can never clear, and the classification of incoming streams. The
  // stream binding effect above reaches it through `screenShareRef`, matching
  // the emitAuditRef / aiAlertDispatcherRef pattern.
  useEffect(() => {
    if (!room) return
    const controller = startScreenShareController({
      room,
      onPeerSharingChange: (peerId, sharing) => {
        if (sharing) return
        // Also fires on peer-leave, so this is the single place a peer's screen
        // tile is retired.
        setPeerScreenStreams((cur) => {
          if (!(peerId in cur)) return cur
          const next = { ...cur }
          delete next[peerId]
          return next
        })
      },
    })
    screenShareRef.current = controller
    return () => {
      screenShareRef.current = null
      controller.teardown()
      // The controller unpublishes; stopping the tracks (and with them the OS
      // screen-recording indicator) belongs to whoever owns the MediaStream,
      // which is this component.
      const stream = screenStreamRef.current
      screenStreamRef.current = null
      if (stream) stopTracks(stream)
      setScreenStream(null)
      setPeerScreenStreams({})
      setExpandedScreen(null)
    }
  }, [room])

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
      onPeerHello: (peerId, hello) => {
        // Ignore hellos from peers the room never admitted (e.g. a 4th peer
        // the host cap bounced before its hello landed) so they don't
        // pollute seenPeerEdPubkeys → markStudied. An admitted peer always
        // has a peers[peerId] entry by the time its hello arrives.
        if (useSessionStore.getState().peers[peerId]) {
          setPeerHello(peerId, hello)
        }
      },
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
        log.error('audit_broadcast.failed', {
          auditKind: kind,
          localAppendSucceeded: true,
          err,
        })
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
      // This mark is what lets the lifecycle layer tell a deliberate
      // departure from a WiFi blip, and it is reliable only because
      // handleLeave awaits this broadcast before room.leave() and both ride
      // the same single ordered data channel — the mark always lands before
      // trystero's own leave notification. Don't drop that await.
      if (verified.kind === 'left') {
        useSessionStore.getState().markPeerDeparted(peerId)
      }
    })

    // #47 B6 — quiet text notes on the same signed-channel trust wiring as
    // audit events: authenticate against the hello binding, drop cross-
    // session payloads, never persist.
    const noteAction = room.makeAction<NotePayload>(NOTE_ACTION)
    noteAction.receive((data, peerId) => {
      const expectedEd =
        useSessionStore.getState().peers[peerId]?.edPubkeyHex ?? null
      const verified = verifyIncomingNote(data, expectedEd, sessionTopic)
      if (!verified) return
      useNotesStore.getState().append({
        fromEdPubkeyHex: verified.from_ed_pubkey,
        mine: false,
        text: verified.text,
        ts: verified.ts,
      })
    })
    sendNoteRef.current = async (text: string) => {
      const payload = await buildNotePayload({
        sessionTopic,
        myEdPubkeyHex,
        text,
        sign,
      })
      if (payload.text.length === 0) return
      // Append local first so the sender sees their note even if the
      // broadcast fails (matches emitAudit's ordering).
      useNotesStore.getState().append({
        fromEdPubkeyHex: myEdPubkeyHex,
        mine: true,
        text: payload.text,
        ts: payload.ts,
      })
      try {
        await noteAction.send(payload)
      } catch (err) {
        // The length, never the text: a session note is the user's own
        // private writing.
        log.error('note_broadcast.failed', {
          textLength: payload.text.length,
          err,
        })
      }
    }

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
    // #47 B6 — notes are session-scoped; a new session starts with a clean
    // feed (ephemeral by design, PLAN §6).
    useNotesStore.getState().reset()
    // S2 — clear any PTT state stranded by a dropped Released event from a
    // PRIOR session so this session's first audio track never comes up live.
    usePttStore.getState().reset()
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot per-session reset of the AI-runtime latch, keyed on startedAt alongside the store resets above; idempotent on re-run
    setAiRuntimeStatus('active')
    return () => {
      cancelActiveBreakTimer((handle) => window.clearTimeout(handle as number))
    }
  }, [status, startedAt])

  // I83 — AI on, session live, but no model to run: say so ONCE per session.
  //
  // The loop effect below returns early in this state, which means
  // `startSampleLoop` never runs and its `onStartFail('no_active_model')`
  // toast — the one surface that names this problem — can never fire. Issue
  // #92 is what that silence looks like from the outside: a full session, an
  // unscored report, and nothing anywhere saying AI sat out.
  //
  // Two distinct causes, two messages: `'ready'` with no model means the user
  // never picked one, while `'error'` means models.json itself couldn't be read
  // — nothing is wrong with their choice and the advice differs. `'loading'`
  // stays silent so a mid-hydration null never accuses a correctly configured
  // install. Keyed on startedAt so a loading → error → ready sequence still
  // toasts at most once per session rather than on every model/camera flap.
  const noModelNoticeShownFor = useRef<number | null>(null)
  useEffect(() => {
    if (status !== 'active' || !startedAt) return
    if (!aiFeaturesEnabled || activeModelId) return
    if (modelStatus !== 'ready' && modelStatus !== 'error') return
    if (noModelNoticeShownFor.current === startedAt) return
    noModelNoticeShownFor.current = startedAt
    toast.error(
      modelStatus === 'error'
        ? strings.session.errors.modelListUnreadable
        : strings.session.errors.pickModel,
      aiSettingsToastAction()
    )
  }, [status, startedAt, aiFeaturesEnabled, modelStatus, activeModelId])

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
    // A new loop instance has reported nothing yet, so it must not inherit the
    // previous one's stall. `onSamplesResumed` is loop-local and fires only
    // when THAT loop had reported a stall, so without this the chip stays
    // "AI paused" forever after the user follows the stall toast's advice and
    // switches to a lighter model (which is what re-runs this effect).
    aiStalledRef.current = false
    // eslint-disable-next-line react-hooks/set-state-in-effect -- resets the AI-runtime latch for a freshly constructed loop; idempotent on re-run
    setAiRuntimeStatus('active')
    let handle: SampleLoopHandle | null = startSampleLoop({
      getTopic: () => useSessionStore.getState().declaredStudyTopic,
      modelId: activeModelId,
      getFaceTrack: () => localStreamRef.current?.getVideoTracks()[0] ?? null,
      // S3 — pause the loop while the camera is off so it never analyzes a
      // black frame; resume is seamless (no skipped ticks, loop state intact).
      // Also paused during a synced pomodoro rest phase: the app just told
      // everyone to take a break (rest notification + chime), so scoring
      // rest-window browsing as off-task contradicted its own timer. Same
      // honest semantics as camera-off — no skipped tally, no streak reset,
      // focused-time % unaffected by the rest window. A peer parking the
      // shared timer in rest to dodge scoring is friends-only-accepted
      // (PLAN §4 principle 5 — you can already disable your own AI).
      isPaused: () =>
        !cameraOnRef.current ||
        usePomodoroStore.getState().phase.startsWith('rest'),
      onScoreEvents: async (events, verdict) => {
        // V2-P6: route every sample's emitted events through the alert
        // dispatcher (warnings → local-only badge + ai_warning audit;
        // alerts → ai_alert audit + signed broadcast + tile highlight).
        // The dispatcher is owned by the hello/audit/pomodoro effect; the
        // ref pattern matches `emitAuditRef` / `pomodoroStartRef`.
        const dispatcher = aiAlertDispatcherRef.current
        if (!dispatcher) return
        await dispatcher.handleScoreEvents(events)
        // A2 — an uncertain sample never carries a wire severity and never
        // clears the self-warning badge: a flaky response shouldn't cancel a
        // pending warning. Only a confident judgment drives handleSeverity.
        if (!isUncertainVerdict(verdict)) {
          dispatcher.handleSeverity(verdict.severity)
        }
      },
      onStartFail: (reason, detail) => {
        if (reason === 'no_active_model') {
          // #47 B2 — the copy names "Settings → AI"; the action takes the
          // user there without leaving the session.
          toast.error(strings.session.errors.pickModel, aiSettingsToastAction())
        } else if (reason === 'model_files_missing') {
          toast.error(
            strings.session.errors.modelFilesMissing,
            aiSettingsToastAction()
          )
        } else if (detail === ERR_ENGINE_NOT_INSTALLED) {
          // I73 — a setup state (auto-install off, engine absent), not a
          // failure worth a raw backend string.
          toast.error(
            strings.session.errors.engineNotInstalled,
            aiSettingsToastAction()
          )
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
      onCaptureError: (err, fatal) => {
        toast.error(strings.session.errors.aiCaptureError(err.message))
        // A transient tick-time capture error (fatal === false) leaves the
        // loop running — it may recover on the next tick, so the chip
        // shouldn't flip to a dead-end "error" state. A boot()-time failure
        // (fatal === true) really did stop the sidecar; without this the
        // chip kept reading "active" while AI was silently dead underneath.
        if (fatal) setAiRuntimeStatus('error')
      },
      onSidecarErrored: (lastError) => {
        toast.error(
          lastError
            ? strings.session.errors.aiCrashedDetail(lastError)
            : strings.session.errors.aiCrashed,
          aiSettingsToastAction()
        )
        setAiRuntimeStatus('error')
      },
      onBatteryPause: (info) => {
        toast.warning(strings.session.errors.aiPausedForBattery(info.percent))
        setAiRuntimeStatus('paused')
      },
      onBatteryResume: () => {
        toast.success(strings.session.errors.aiResumed)
        // Leaving the battery pause only proves the battery recovered. If AI
        // was already stalled when the pause began, it still is.
        if (!aiStalledRef.current) setAiRuntimeStatus('active')
      },
      onThermalBackoff: () => {
        // A6 — one-shot per session; the loop fires this at most once.
        toast(strings.session.errors.aiSlowedDown)
      },
      // I82 — the loop went long enough without a single reading that the
      // session would otherwise end with an unexplained "No focus score".
      // Three surfaces, because one was never enough: the chip stops
      // claiming "AI watching", a toast names the blocker while the session
      // is still live and fixable, and a local-only audit row puts it in the
      // session log — which is what the post-session report reads.
      onSamplesStalled: (reason) => {
        aiStalledRef.current = true
        // An engine that has produced nothing for two minutes is an error,
        // not a pause — the same reading onStartFail / onCaptureError(fatal)
        // / onSidecarErrored already give. The input-absent reasons
        // (camera_missing, screen_lost, capture_failing) genuinely are a
        // pause: nothing is broken, there is just nothing to look at.
        setAiRuntimeStatus(
          AI_ENGINE_BLOCK_REASONS.has(reason) ? 'error' : 'paused'
        )
        toast.warning(
          AI_NO_READING_TOAST[reason],
          AI_ENGINE_BLOCK_REASONS.has(reason)
            ? aiSettingsToastAction()
            : undefined
        )
        void appendLocalAuditRef
          .current?.('ai_stalled', {
            reason,
            reasoning: AI_NO_READING_LOG[reason],
          })
          .catch((err: unknown) => {
            log.error('audit.ai_stalled_append_failed', { reason, err })
          })
      },
      onSamplesResumed: () => {
        aiStalledRef.current = false
        setAiRuntimeStatus('active')
        toast.success(strings.session.errors.aiReadingsResumed)
      },
    })
    return () => {
      const local = handle
      handle = null
      void local?.stop()
    }
  }, [status, aiFeaturesEnabled, activeModelId, localStream, captureDenied])

  // V2-P9 gesture fix safety net — a gesture handler (TopicGateModal submit,
  // fired BEFORE this component even mounts, the AiCategory toggle, or
  // handleCaptureRetry above) may pre-acquire a long-lived screen stream
  // that the effect above never ends up consuming (e.g. the camera never
  // comes up, so `localStream` never satisfies the effect's guard). Without
  // this, that stream — and the OS recording indicator it lights — would
  // stay alive for no reason until the app quits. Bounding the leak to "at
  // most this SessionView's lifetime" is enough. Deliberately NOT also
  // discarding on mount: a pre-acquire from the TopicGateModal submit that
  // started this very session landed in the stash before SessionView
  // mounted at all, and boot() (the effect above) hasn't had a chance to
  // consume it yet — clearing here too would just race and defeat it.
  useEffect(() => {
    return () => discardPendingScreenStream()
  }, [])

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
        // The dialog closing between request and response is the normal
        // case, so this is debug rather than a warning nobody can act on.
        dialogLog.debug('emit.failed', { event, err })
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
              dialogLog.error('topic_change_audit.failed', {
                previousTopicLength: previous.length,
                newTopicLength: next.length,
                err,
              })
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
              reason: strings.ai.dialog.sessionNotReady,
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
              dialogLog.error('break_flow.failed', {
                fallbackVerdict: 'denied',
                err,
              })
              emitToDialog(AI_DIALOG_BREAK_RESPONSE, {
                nonce: payload.nonce,
                verdict: 'denied',
                reason:
                  err instanceof Error
                    ? err.message
                    : strings.ai.dialog.unexpectedError,
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
      // #47 B2 — any open modal (Radix dialogs) or the settings overlay
      // (role=dialog, intentionally not aria-modal so the custom-chrome
      // TitleBar stays AT-reachable) owns Esc. Arming leave-on-Esc
      // underneath one risks an invisible second-Esc ending the session
      // for everyone.
      if (
        document.querySelector('[aria-modal="true"], [data-settings-overlay]')
      ) {
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
        const newTrack = await swapAudioInput(
          nextDeviceId,
          {
            getUserMedia: (constraints) =>
              navigator.mediaDevices.getUserMedia(constraints),
            room,
            localStream: stream,
          },
          () => usePttStore.getState().active
        )
        // #47 A3 — re-attach the I42 device-loss recovery to the swapped-in
        // track: the acquire effect's 'ended' listeners only cover tracks
        // present at acquisition, so without this the exact churn the swap
        // exists for (USB/Bluetooth headset unplugged mid-session) fails
        // silently — no banner, peers keep a dead sender, PTT toggles a dead
        // track. Same live-stream guard as the acquire-time handler; after
        // teardown localStreamRef is null so a late 'ended' no-ops.
        newTrack.addEventListener('ended', () => {
          if (localStreamRef.current !== stream) return
          setMediaErrorName('NotReadableError')
        })
        setActiveAudioDeviceId(nextDeviceId)
        // #47 B4 — an explicit pick persists across sessions (the OS-default
        // id surfaced at acquisition deliberately does not).
        void useSettingsStore.getState().setAudioInputDeviceId(nextDeviceId)
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

  const handleToggleCamera = useCallback(() => {
    setCameraOn((on) => !on)
  }, [])

  // #96 — stop sharing. Reached from the footer toggle, from the OS-level "Stop
  // sharing" control (the track's 'ended' event), and from session teardown.
  const stopScreenShare = useCallback(() => {
    const stream = screenStreamRef.current
    screenStreamRef.current = null
    setScreenStream(null)
    setExpandedScreen((cur) => (cur === LOCAL_SCREEN_KEY ? null : cur))
    screenShareRef.current?.unpublish()
    if (stream) stopTracks(stream)
  }, [])

  const handleToggleScreenShare = useCallback(() => {
    if (screenStreamRef.current) {
      stopScreenShare()
      toast(strings.session.screenShare.stoppedToast)
      return
    }
    // getDisplayMedia has to run inside the live user activation of this click
    // on both WebView2 and WKWebView (the V2-P9 gesture constraint), so it is
    // called here with nothing awaited in front of it.
    void requestScreenShareStream()
      .then((stream) => {
        const controller = screenShareRef.current
        if (!controller) {
          // The session ended while the OS picker was open.
          stopTracks(stream)
          return
        }
        // The OS "Stop sharing" affordance ends the track without telling us
        // anything else; without this the tile would freeze and peers would
        // keep a dead sender.
        for (const track of stream.getTracks()) {
          track.addEventListener('ended', () => {
            if (screenStreamRef.current !== stream) return
            stopScreenShare()
          })
        }
        screenStreamRef.current = stream
        setScreenStream(stream)
        controller.publish(stream)
        toast.success(strings.session.screenShare.startedToast)
      })
      .catch((err: unknown) => {
        // Dismissing the picker and a system-level screen-recording block both
        // reject with NotAllowedError and cannot be told apart, so the copy
        // covers either and this stays a neutral toast rather than an error.
        const name =
          typeof err === 'object' && err !== null && 'name' in err
            ? String((err as { name: unknown }).name)
            : ''
        if (mediaErrorKind(name) !== 'denied') {
          toast.error(strings.session.screenShare.failedToast)
          return
        }
        toast(
          strings.session.screenShare.blockedToast,
          isMacLikePlatform()
            ? {
                action: {
                  label: strings.session.screenShare.openSettingsCta,
                  onClick: () => {
                    void invoke('system_open_screen_capture_settings').catch(
                      () => {}
                    )
                  },
                },
              }
            : undefined
        )
      })
  }, [stopScreenShare])

  const handleSelectOutputDevice = useCallback((deviceId: string) => {
    setActiveOutputDeviceId(deviceId)
    // #47 B4 — headset users shouldn't re-pick every session.
    void useSettingsStore.getState().setAudioOutputDeviceId(deviceId)
  }, [])

  // #47 B4 — persist per-friend volume keyed by the signed-hello ed_pubkey
  // binding (peerIds are per-session). Trailing debounce so a slider drag
  // doesn't write settings.json per tick; the in-memory value updates
  // immediately.
  const volumePersistTimersRef = useRef<Record<string, number>>({})
  const handlePeerVolumeChange = useCallback(
    (peerId: string, volume: number) => {
      setPeerVolumes((cur) => ({ ...cur, [peerId]: volume }))
      const edPubkeyHex =
        useSessionStore.getState().peers[peerId]?.edPubkeyHex ?? null
      if (!edPubkeyHex) return
      const timers = volumePersistTimersRef.current
      clearTimeout(timers[edPubkeyHex])
      timers[edPubkeyHex] = setTimeout(() => {
        void useSettingsStore.getState().setPeerVolume(edPubkeyHex, volume)
      }, 500) as unknown as number
    },
    []
  )

  // #47 B6 — panel callbacks. Send goes through the effect-owned wire ref;
  // names resolve exactly like the audit panel's (self label for mine,
  // cumulative seenPeerNames for peers so a departed peer keeps their name).
  const handleSendNote = useCallback((text: string) => {
    void sendNoteRef.current?.(text)
  }, [])
  const resolveNoteName = useCallback(
    (note: SessionNote) => {
      if (note.mine) {
        return (
          useIdentityStore.getState().identity?.display_name?.trim() ||
          strings.session.selfFallback
        )
      }
      return (
        seenPeerNames[note.fromEdPubkeyHex] ??
        strings.session.peerFallback(note.fromEdPubkeyHex)
      )
    },
    [seenPeerNames]
  )

  const handleStartPomodoro = useCallback((args: PomodoroStartArgs) => {
    pomodoroStartRef.current?.(args)
  }, [])
  const handleStopPomodoro = useCallback(() => {
    pomodoroStopRef.current?.()
  }, [])

  // "Try again" — clear the error and bump the nonce so the acquisition
  // effect (keyed on [room, mediaRetryNonce]) re-runs getUserMedia.
  // I83 — a camera/mic retry re-acquires `localStream`, which is in the
  // sample-loop effect's deps, so the loop tears down and boot()s again. That
  // second boot() reaches getDisplayMedia with an empty gesture stash and, on
  // WebView2, is refused outright — recovering the camera would silently cost
  // the user AI for the rest of the session. This click is a real gesture;
  // spend it on a screen pre-acquire too, under the same AI-is-actually-running
  // condition the loop effect uses.
  const handleMediaRetry = useCallback(() => {
    if (aiFeaturesEnabled && activeModelId && !captureDenied) {
      void preacquireScreenStream()
    }
    setMediaErrorName(null)
    setMediaRetryNonce((n) => n + 1)
  }, [aiFeaturesEnabled, activeModelId, captureDenied])

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
  //
  // V2-P9 gesture fix — this click is the gesture: pre-acquire (stash for
  // boot() to consume) rather than seed-and-release-then-let-boot()-
  // reacquire, which would be a second getDisplayMedia() call with no
  // gesture left to satisfy it. Whatever the outcome (grant or another
  // denial), the effect re-run below drives boot() to consume it, and
  // boot()'s existing onCaptureDenied/onCaptureError handling takes it from
  // there — no need to duplicate that branching here.
  const handleCaptureRetry = useCallback(() => {
    void preacquireScreenStream()
    useFocusStore.getState().reset()
    setCaptureDenied(false)
    setAiRuntimeStatus('active')
  }, [])

  const auditEntries = useMemo(
    () => mapAuditEntries(auditEvents, identity, peers, seenPeerNames),
    [auditEvents, identity, peers, seenPeerNames]
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
  //
  // I83 — the decision moved to `deriveAiChipStatus` (pure, unit-tested) to add
  // the 'unconfigured' case: AI on with no model used to read "AI off", which is
  // the one reading that sends a user to the wrong setting.
  const aiChipStatus: AiStatus = deriveAiChipStatus({
    aiFeaturesEnabled,
    activeModelId,
    modelStatus,
    hasLocalStream: Boolean(localStream),
    runtimeStatus: aiRuntimeStatus,
  })

  if (!room) return null

  const peerEntries = Object.values(peers)
  // #47 A2 — the invite affordance renders only for the host (a guest's
  // invite would throw InviteWhileGuestError) and only when Home injected
  // presence + a sender. Friends already in the session are filtered by
  // their signed-hello ed_pubkey binding; the picker shows the full-session
  // notice once the live remote-peer count hits the host-enforced cap.
  const canInvite = isHost && onInviteFriend !== undefined
  const inSessionEdPubkeys = new Set(
    peerEntries.flatMap((p) => (p.edPubkeyHex ? [p.edPubkeyHex] : []))
  )
  const sessionFull = peerEntries.length >= MAX_REMOTE_PEERS
  const presenceCheck = (edPubkeyHex: string) =>
    presence !== undefined && isOnline(presence, edPubkeyHex)
  const youName = identity?.display_name?.trim() || strings.session.selfFallback
  // #96 — resolve the expanded screen from its key at render time, so a share
  // that stops (locally or remotely) closes the viewer without a second piece
  // of state to keep in step.
  const expandedScreenStream =
    expandedScreen === null
      ? null
      : expandedScreen === LOCAL_SCREEN_KEY
        ? screenStream
        : (peerScreenStreams[expandedScreen] ?? null)
  // Radix keeps the dialog mounted through its close animation, so this still
  // renders for a frame after the key clears — hence the null branch, without
  // which the title would flip to a mangled peer label on the way out.
  const expandedScreenName =
    expandedScreen === null
      ? ''
      : expandedScreen === LOCAL_SCREEN_KEY
        ? strings.session.screenShare.selfTileName
        : strings.session.screenShare.peerTileName(
            peerEntries.find((p) => p.peerId === expandedScreen)?.displayName ??
              peerLabel(expandedScreen)
          )
  const broadcasterName = pomodoroSnapshot.iAmBroadcaster
    ? strings.session.broadcasterSelf
    : pomodoroSnapshot.broadcasterEdPubkey
      ? (peerEntries.find(
          (p) => p.edPubkeyHex === pomodoroSnapshot.broadcasterEdPubkey
        )?.displayName ?? null)
      : null

  return (
    <main
      // #95 — `h-full`, not `min-h-full`: the session view is a fixed cockpit,
      // not a document that scrolls. Pinning it to the window is what leaves
      // the video column a definite height to hand VideoGrid, which sizes the
      // tiles to fill it. The grid scrolls internally if the tiles ever can't.
      className="flex h-full flex-col bg-bg-base text-text-primary"
      aria-label={strings.session.mainAriaLabel}
    >
      {/* V3-P7 — Visually-hidden top-level heading so SR users have a clean
          one-h1-per-route anchor. The visible UI is the video grid + audit
          panel + footer; none of those would carry "the page title" on their
          own. */}
      <h1 className="sr-only">{strings.app.sessionSrHeading}</h1>
      <div className="flex min-h-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col px-6 py-6">
          {mediaErrorName !== null ? (
            <MediaErrorBanner
              className="shrink-0"
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
          <VideoGrid className="min-h-0 flex-1">
            <VideoTile
              key="local"
              name={youName}
              stream={localStream}
              ptt={pttActive}
              isLocal
              cameraOff={!cameraOn}
              state={selfTileState}
              alertReasoning={selfAlertReasoning}
            />
            {screenStream ? (
              <VideoTile
                key="local-screen"
                name={strings.session.screenShare.selfTileName}
                stream={screenStream}
                variant="screen"
                isLocal
                onExpand={() => setExpandedScreen(LOCAL_SCREEN_KEY)}
              />
            ) : null}
            {peerEntries.length === 0 ? (
              <WaitingTile
                key="waiting"
                variant={hadAnyPeer ? 'reconnect' : 'invite'}
              />
            ) : null}
            {peerEntries.flatMap((peer) => {
              const peerStream = remoteStreams[peer.peerId] ?? null
              const peerAlert = peer.edPubkeyHex
                ? alertedPeers[peer.edPubkeyHex]
                : undefined
              // Peer state precedence: an off-task alert (broadcast over the
              // always-wired data channel, regardless of OUR aiFeaturesEnabled)
              // wins while the peer's media is up. Otherwise F4 surfaces the
              // WebRTC transport state — 'connecting' while ICE is mid-
              // handshake or after a transient 'disconnected', 'failed' only on
              // a terminally dead connection — so a peer with no tracks yet no
              // longer reads as a frozen offline tile.
              const peerState: FocusState | undefined =
                peerStream && peerAlert
                  ? 'alerted'
                  : connectionFocusState(peerConnState[peer.peerId], peerStream)
              const peerName = peer.displayName ?? peerLabel(peer.peerId)
              // #96 — an array (not a fragment) so VideoGrid's Children.count
              // still sees one entry per tile and picks the right column count.
              const tiles = [
                <VideoTile
                  key={peer.peerId}
                  name={peerName}
                  stream={peerStream}
                  ptt={peerPtt[peer.peerId] ?? false}
                  cameraOff={peerCameraOff[peer.peerId] ?? false}
                  state={peerState}
                  alertReasoning={peerAlert?.reasoning}
                  sinkId={activeOutputDeviceId ?? undefined}
                  volume={
                    peerVolumes[peer.peerId] ??
                    (peer.edPubkeyHex
                      ? persistedPeerVolumes[peer.edPubkeyHex]
                      : undefined) ??
                    DEFAULT_PEER_VOLUME
                  }
                  onVolumeChange={(v) => handlePeerVolumeChange(peer.peerId, v)}
                />,
              ]
              const peerScreen = peerScreenStreams[peer.peerId]
              if (peerScreen) {
                tiles.push(
                  <VideoTile
                    key={`${peer.peerId}-screen`}
                    name={strings.session.screenShare.peerTileName(peerName)}
                    stream={peerScreen}
                    variant="screen"
                    onExpand={() => setExpandedScreen(peer.peerId)}
                  />
                )
              }
              return tiles
            })}
          </VideoGrid>
        </div>
        <div
          className="flex min-h-0 flex-col"
          style={{ width: tokens.sizes.auditPanelWidth }}
        >
          <AuditLogPanel
            events={auditEntries}
            className="h-auto min-h-0 flex-1"
          />
          <SessionNotesPanel
            notes={sessionNotes}
            resolveName={resolveNoteName}
            onSend={handleSendNote}
          />
        </div>
      </div>
      <footer className="flex shrink-0 items-center justify-between gap-4 border-t border-border-subtle bg-bg-surface px-6 py-4 text-sm">
        <span className="flex items-center gap-3 text-text-secondary">
          <span className="flex items-center gap-2">
            {strings.session.footerHoldBefore}
            <Kbd>{pttFriendsLabel}</Kbd>
            {strings.session.footerHoldAfter}
          </span>
          <AudioDevicePicker
            currentDeviceId={activeAudioDeviceId}
            onSelect={handleSwapAudioDevice}
            swapping={audioSwapping}
          />
          <AudioOutputPicker
            currentDeviceId={activeOutputDeviceId}
            onSelect={handleSelectOutputDevice}
          />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleToggleCamera}
            aria-pressed={cameraOn}
            aria-label={strings.session.camera.toggleAriaLabel}
            className="gap-2"
          >
            {cameraOn ? <VideoIcon /> : <VideoOffIcon />}
          </Button>
          {/* #96 — the stop side carries a visible label as well as the icon:
              sharing your screen is the one control here whose "on" state you
              want to be able to find and undo at a glance. */}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleToggleScreenShare}
            aria-pressed={screenStream !== null}
            // Only the icon-only (not sharing) state needs a label. While
            // sharing, the visible "Stop sharing" text IS the accessible name —
            // an aria-label would override it and leave the two disagreeing
            // (WCAG 2.5.3 Label in Name).
            aria-label={
              screenStream
                ? undefined
                : strings.session.screenShare.toggleAriaLabel
            }
            className="gap-2"
          >
            {screenStream ? (
              <>
                <ScreenShareOffIcon />
                {strings.session.screenShare.stopCta}
              </>
            ) : (
              <ScreenShareIcon />
            )}
          </Button>
          {onOpenSettings ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => onOpenSettings()}
              aria-haspopup="dialog"
              aria-label={strings.settings.openAriaLabel}
            >
              <Settings2Icon />
            </Button>
          ) : null}
        </span>
        <span className="flex items-center gap-4">
          {onOpenSettings ? (
            <button
              type="button"
              className="rounded-md outline-none focus-visible:ring-3 focus-visible:ring-accent-ring"
              onClick={() => onOpenSettings('ai')}
              aria-label={strings.session.aiStatus.openSettingsAriaLabel(
                strings.session.aiStatus[aiChipStatus]
              )}
            >
              <AiStatusChip status={aiChipStatus} />
            </button>
          ) : (
            <AiStatusChip status={aiChipStatus} />
          )}
          <ElapsedTime startedAt={startedAt} startedAtMono={startedAtMono} />
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
        <span className="flex items-center gap-2">
          {canInvite ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setInviteOpen(true)}
              aria-haspopup="dialog"
              aria-label={strings.session.invite.ctaAriaLabel}
              className="gap-2"
            >
              <UserPlusIcon /> {strings.session.invite.cta}
            </Button>
          ) : null}
          <Button
            variant="secondary"
            size="sm"
            onClick={handleLeave}
            aria-keyshortcuts="Escape"
          >
            {strings.session.leaveCta}
          </Button>
        </span>
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
      <ScreenShareViewer
        open={expandedScreenStream !== null}
        onOpenChange={(next) => {
          if (!next) setExpandedScreen(null)
        }}
        name={expandedScreenName}
        stream={expandedScreenStream}
      />
      {canInvite ? (
        <SessionInviteDialog
          open={inviteOpen}
          onOpenChange={setInviteOpen}
          friends={friends}
          isOnline={presenceCheck}
          inSessionEdPubkeys={inSessionEdPubkeys}
          full={sessionFull}
          onInvite={onInviteFriend}
        />
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
  >,
  seenPeerNames: Record<string, string>
): AuditLogEntry[] {
  // Build a one-shot ed_pubkey → name map. Resolution order (last write
  // wins): cumulative seen names (so a departed peer's past rows keep their
  // name) < the local user's own identity < live peer bindings (a fresh
  // name still wins over a stale cached one).
  const byEdPubkey = new Map<string, string>()
  for (const [ed, name] of Object.entries(seenPeerNames)) {
    byEdPubkey.set(ed, name)
  }
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
    // I82 — `ai_stalled` reuses the same `detail.reasoning` slot, carrying the
    // short "why AI couldn't read" phrase rather than a model judgment.
    case 'ai_warning':
    case 'ai_alert':
    case 'ai_stalled': {
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

function useElapsed(
  startedAt: number | null,
  startedAtMono: number | null
): string {
  const [tick, setTick] = useState(() => ({
    wall: Date.now(),
    mono: performance.now(),
  }))
  useEffect(() => {
    const handle = setInterval(
      () => setTick({ wall: Date.now(), mono: performance.now() }),
      1000
    )
    return () => clearInterval(handle)
  }, [])
  if (!startedAt) return '00:00'
  // Same min(wall, monotonic) rule the persisted total uses (see
  // buildLeaveHandler), so the footer and the report row agree after the
  // machine has been asleep instead of the footer reading 612:34 on wake.
  const wallMs = tick.wall - startedAt
  const elapsedMs =
    startedAtMono === null
      ? wallMs
      : Math.min(wallMs, tick.mono - startedAtMono)
  const seconds = Math.max(0, Math.floor(elapsedMs / 1000))
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

// Leaf that owns the 1-second elapsed tick so the whole-session clock updates
// in the footer without re-rendering SessionView — mirrors SessionTimer's
// useRemainingMs isolation. The `tick` state lives here, not in SessionView's
// render body, so the interval only reconciles this one span.
function ElapsedTime({
  startedAt,
  startedAtMono,
}: {
  startedAt: number | null
  startedAtMono: number | null
}) {
  const elapsed = useElapsed(startedAt, startedAtMono)
  return (
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
  )
}
