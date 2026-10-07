import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import {
  BotIcon,
  MicIcon,
  MicOffIcon,
  ScreenShareIcon,
  ScreenShareOffIcon,
  Settings2Icon,
  VideoIcon,
  VideoOffIcon,
} from 'lucide-react'
import { toast } from 'sonner'

import { AiResponseBubble } from '@/components/AiResponseBubble'
import { AiStatusChip } from '@/components/AiStatusChip'
import { AiTextBox } from '@/components/AiTextBox'
import { AudioDevicePicker } from '@/components/AudioDevicePicker'
import { AudioOutputPicker } from '@/components/AudioOutputPicker'
import { AuditLogPanel } from '@/components/AuditLogPanel'
import { BreakCountdownBadge } from '@/components/BreakCountdownBadge'
import { MediaErrorBanner } from '@/components/MediaErrorBanner'
import { ScreenShareViewer } from '@/components/ScreenShareViewer'
import { SelfWarningBadge } from '@/components/SelfWarningBadge'
import { SessionTimer } from '@/components/SessionTimer'
import { VideoGrid } from '@/components/VideoGrid'
import { VideoTile } from '@/components/VideoTile'
import { WaitingTile } from '@/components/WaitingTile'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { SessionImageViewer } from '@/features/session/SessionImageViewer'
import { SessionInviteDialog } from '@/features/session/SessionInviteDialog'
import { SessionNotesPanel } from '@/features/session/SessionNotesPanel'
import { ReportView } from '@/features/session/Report'
import type { SessionImage, SessionNote } from '@/features/session/notesStore'
import { validateOutgoingImage } from '@/features/session/images'
import { strings } from '@/strings'
import type { BrowserConnection } from './browserConnection'
import { readMirrorReport } from './reportValidation'
import {
  base64ToBytes,
  blobToBase64,
  readMirrorSnapshot,
  type MirrorControl,
} from './sessionBridge'

export type MirrorSessionProps = { connection: BrowserConnection }

function pairingErrorCopy(error: string | null): string {
  const copy = strings.mirror
  switch (error) {
    case 'rate_limited':
      return copy.pairRateLimited
    case 'in_use':
      return copy.pairInUse
    case 'session_moved':
      return copy.sessionMoved
    default:
      return copy.pairFailed
  }
}

export function MirrorSession({ connection }: MirrorSessionProps) {
  const state = useSyncExternalStore(connection.subscribe, connection.getState)
  const snapshot = useMemo(
    () => readMirrorSnapshot(state.snapshot),
    [state.snapshot]
  )
  const report = useMemo(() => readMirrorReport(state.report), [state.report])
  const hasReport = report !== null
  const connected =
    state.status === 'connected' && snapshot?.status === 'active'
  const [password, setPassword] = useState('')
  const [pairing, setPairing] = useState(false)
  const [camera, setCamera] = useState<MediaStream | null>(null)
  const [screen, setScreen] = useState<MediaStream | null>(null)
  const [mediaError, setMediaError] = useState<string | null>(null)
  const [cameraBusy, setCameraBusy] = useState(false)
  const [screenBusy, setScreenBusy] = useState(false)
  const [audioDevice, setAudioDevice] = useState<string | null>(null)
  const [outputDevice, setOutputDevice] = useState<string | null>(null)
  const [volumes, setVolumes] = useState<Record<string, number>>({})
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [aiConsentOpen, setAiConsentOpen] = useState(false)
  const [aiOpen, setAiOpen] = useState(false)
  const [aiText, setAiText] = useState('')
  const [topicDraft, setTopicDraft] = useState('')
  const [inviteOpen, setInviteOpen] = useState(false)
  const [expandedScreen, setExpandedScreen] = useState<string | null>(null)
  const [imageId, setImageId] = useState<string | null>(null)
  const [images, setImages] = useState<SessionImage[]>([])
  const [talking, setTalking] = useState(false)
  const [notificationHelp, setNotificationHelp] = useState<string | null>(null)
  const [awake, setAwake] = useState(false)
  const capturesRef = useRef({ camera, screen })
  useEffect(() => {
    capturesRef.current = { camera, screen }
  }, [camera, screen])
  const talkRef = useRef(false)
  const imageCacheRef = useRef(
    new Map<string, { data: string; image: SessionImage }>()
  )
  const wakeRef = useRef<WakeLockSentinel | null>(null)
  const wakeRequestRef = useRef(0)
  const mediaScopeRef = useRef(0)
  const cameraRequestRef = useRef(0)
  const screenRequestRef = useRef(0)
  const copy = strings.mirror
  const pairingError = pairingErrorCopy(state.error)
  const control = useCallback(
    (action: MirrorControl) => connection.sendControl(action),
    [connection]
  )
  useEffect(() => {
    let previous = connection.getState()
    const id = (snapshot: unknown) =>
      snapshot && typeof snapshot === 'object' && 'sessionId' in snapshot
        ? snapshot.sessionId
        : null
    const off = connection.subscribe((next) => {
      if (
        next.status !== previous.status ||
        id(next.snapshot) !== id(previous.snapshot) ||
        next.report !== previous.report
      )
        mediaScopeRef.current += 1
      previous = next
    })
    return () => {
      off()
      mediaScopeRef.current += 1
    }
  }, [connection])
  const currentSession = (epoch: number, sessionId: string) => {
    const latest = connection.getState()
    const latestSnapshot = readMirrorSnapshot(latest.snapshot)
    return (
      epoch === mediaScopeRef.current &&
      latest.status === 'connected' &&
      latest.report === null &&
      latestSnapshot?.sessionId === sessionId &&
      latestSnapshot.status === 'active'
    )
  }

  useEffect(() => {
    const cache = imageCacheRef.current
    const next: SessionImage[] = []
    for (const item of snapshot?.images ?? []) {
      let existing = cache.get(item.id)
      if (!existing || existing.data !== item.data) {
        if (existing) URL.revokeObjectURL(existing.image.objectUrl)
        const bytes = base64ToBytes(item.data)
        const blob = new Blob([bytes], { type: item.mimeType })
        const image: SessionImage = {
          ...item,
          blob,
          objectUrl: URL.createObjectURL(blob),
        }
        existing = { data: item.data, image }
        cache.set(item.id, existing)
      }
      next.push(existing.image)
    }
    const keep = new Set(next.map((image) => image.id))
    for (const [id, cached] of cache) {
      if (keep.has(id)) continue
      URL.revokeObjectURL(cached.image.objectUrl)
      cache.delete(id)
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect -- materialize browser-owned object URLs from the host's image snapshot
    setImages(next)
  }, [snapshot?.images])

  useEffect(
    () => () => {
      for (const cached of imageCacheRef.current.values())
        URL.revokeObjectURL(cached.image.objectUrl)
      imageCacheRef.current.clear()
      wakeRequestRef.current += 1
      void wakeRef.current?.release().catch(() => {})
      wakeRef.current = null
    },
    []
  )

  const stopTalking = useCallback(() => {
    talkRef.current = false
    for (const track of capturesRef.current.camera?.getAudioTracks() ?? [])
      track.enabled = false
    setTalking(false)
    control({ type: 'ptt', active: false })
  }, [control])
  const startTalking = () => {
    if (!connected || !camera) return
    talkRef.current = true
    for (const track of camera.getAudioTracks()) track.enabled = true
    setTalking(true)
    control({ type: 'ptt', active: true })
  }
  useEffect(() => {
    window.addEventListener('blur', stopTalking)
    const hidden = () => {
      if (document.visibilityState === 'hidden') stopTalking()
    }
    document.addEventListener('visibilitychange', hidden)
    return () => {
      window.removeEventListener('blur', stopTalking)
      document.removeEventListener('visibilitychange', hidden)
      stopTalking()
    }
  }, [stopTalking])
  useEffect(() => {
    if (state.status === 'connected') return
    let cancelled = false
    queueMicrotask(() => {
      if (cancelled) return
      stopTalking()
      cameraRequestRef.current += 1
      screenRequestRef.current += 1
      setCameraBusy(false)
      setScreenBusy(false)
      setCamera(null)
      setScreen(null)
    })
    return () => {
      cancelled = true
    }
  }, [state.status, stopTalking])
  useEffect(() => {
    for (const track of camera?.getVideoTracks() ?? [])
      track.enabled = snapshot?.cameraOn ?? true
  }, [camera, snapshot?.cameraOn])
  useEffect(() => {
    let cancelled = false
    queueMicrotask(() => {
      if (cancelled) return
      setAiOpen(false)
      setSettingsOpen(false)
      setAiConsentOpen(false)
      setAiText('')
      setTopicDraft('')
      setInviteOpen(false)
      setExpandedScreen(null)
      setImageId(null)
    })
    return () => {
      cancelled = true
    }
  }, [snapshot?.sessionId, hasReport])
  useEffect(() => {
    const release = () => {
      wakeRequestRef.current += 1
      const held = wakeRef.current
      wakeRef.current = null
      void held?.release().catch(() => {})
      setAwake(false)
    }
    if (connected && !report) return release
    release()
  }, [connected, report, snapshot?.sessionId])

  const acquireCamera = (deviceId = audioDevice) => {
    if (!connected || !snapshot) return
    if (typeof navigator.mediaDevices?.getUserMedia !== 'function') {
      setMediaError('NotSupportedError')
      return
    }
    // I129 — permission dialogs can resolve after a disconnect or a new pairing.
    const epoch = mediaScopeRef.current
    const sessionId = snapshot.sessionId
    const request = ++cameraRequestRef.current
    setCameraBusy(true)
    void navigator.mediaDevices
      .getUserMedia({
        video: true,
        audio: deviceId ? { deviceId: { ideal: deviceId } } : true,
      })
      .then((stream) => {
        if (
          request !== cameraRequestRef.current ||
          !currentSession(epoch, sessionId)
        ) {
          for (const track of stream.getTracks()) track.stop()
          return
        }
        for (const track of stream.getAudioTracks())
          track.enabled = talkRef.current
        for (const track of stream.getVideoTracks())
          track.enabled =
            readMirrorSnapshot(connection.getState().snapshot)?.cameraOn ?? true
        for (const track of stream.getTracks())
          track.addEventListener(
            'ended',
            () => {
              if (capturesRef.current.camera !== stream) return
              setMediaError('NotReadableError')
              setCamera(null)
              stopTalking()
            },
            { once: true }
          )
        connection.setCapture('camera', stream)
        setCamera(stream)
        setAudioDevice(
          stream.getAudioTracks()[0]?.getSettings().deviceId ?? null
        )
        setMediaError(null)
      })
      .catch((error: unknown) => {
        if (
          request !== cameraRequestRef.current ||
          !currentSession(epoch, sessionId)
        )
          return
        setMediaError(
          error && typeof error === 'object' && 'name' in error
            ? String(error.name)
            : 'NotReadableError'
        )
      })
      .finally(() => {
        if (request === cameraRequestRef.current) setCameraBusy(false)
      })
  }
  const acquireScreen = (sharing: boolean) => {
    if (
      !connected ||
      typeof navigator.mediaDevices?.getDisplayMedia !== 'function'
    ) {
      toast(copy.screenUnavailable)
      return
    }
    const epoch = mediaScopeRef.current
    const sessionId = snapshot!.sessionId
    const request = ++screenRequestRef.current
    setScreenBusy(true)
    void navigator.mediaDevices
      .getDisplayMedia({ video: { frameRate: { max: 15 } }, audio: false })
      .then((stream) => {
        if (
          request !== screenRequestRef.current ||
          !currentSession(epoch, sessionId)
        ) {
          for (const track of stream.getTracks()) track.stop()
          return
        }
        for (const track of stream.getTracks())
          track.addEventListener(
            'ended',
            () => {
              if (capturesRef.current.screen !== stream) return
              setScreen(null)
              control({ type: 'screen_sharing', sharing: false })
            },
            { once: true }
          )
        connection.setCapture('screen', stream)
        setScreen(stream)
        if (sharing) control({ type: 'screen_sharing', sharing: true })
      })
      .catch(() => {
        if (
          request === screenRequestRef.current &&
          currentSession(epoch, sessionId)
        )
          toast(copy.screenFailed)
      })
      .finally(() => {
        if (request === screenRequestRef.current) setScreenBusy(false)
      })
  }
  const stopScreen = () => {
    screenRequestRef.current += 1
    setScreenBusy(false)
    control({ type: 'screen_sharing', sharing: false })
    connection.setCapture('screen', null)
    setScreen(null)
  }
  const enableAudio = () => {
    for (const video of document.querySelectorAll('video'))
      void video.play().catch(() => {})
  }
  const pair = async () => {
    setPairing(true)
    try {
      await connection.pair(password)
      setPassword('')
    } catch {
      const error = connection.getState().error
      toast.error(pairingErrorCopy(error))
    } finally {
      setPairing(false)
    }
  }
  const notifications = async () => {
    if (!('Notification' in window)) {
      setNotificationHelp(copy.notificationsUnavailable)
      return
    }
    try {
      const result = await Notification.requestPermission()
      setNotificationHelp(result === 'denied' ? copy.notificationsDenied : null)
    } catch {
      setNotificationHelp(copy.notificationsUnavailable)
    }
  }
  const toggleAwake = async (next: boolean) => {
    const request = ++wakeRequestRef.current
    if (!next) {
      void wakeRef.current?.release().catch(() => {})
      wakeRef.current = null
      setAwake(false)
      return
    }
    if (!connected || !snapshot) return
    const epoch = mediaScopeRef.current
    const sessionId = snapshot.sessionId
    try {
      const lock = await navigator.wakeLock.request('screen')
      if (
        request !== wakeRequestRef.current ||
        !currentSession(epoch, sessionId)
      ) {
        await lock.release()
        return
      }
      wakeRef.current = lock
      setAwake(true)
      lock.addEventListener('release', () => {
        if (wakeRef.current !== lock) return
        wakeRef.current = null
        setAwake(false)
      })
    } catch {
      if (
        request === wakeRequestRef.current &&
        currentSession(epoch, sessionId)
      )
        toast(copy.awakeUnavailable)
    }
  }
  const resolveName = (item: SessionNote | SessionImage) =>
    item.mine
      ? snapshot?.self.displayName || strings.session.selfFallback
      : (snapshot?.names[item.fromEdPubkeyHex] ??
        strings.session.peerFallback(item.fromEdPubkeyHex))
  const openImage = images.find((image) => image.id === imageId) ?? null
  const tileStream = (key: string) =>
    key === 'self:camera'
      ? camera
      : key === 'self:screen'
        ? screen
        : (state.streams[key] ?? null)
  const expandedTile = snapshot?.tiles.find(
    (tile) => tile.key === expandedScreen
  )
  const expandedStream = expandedScreen ? tileStream(expandedScreen) : null
  const online = new Set(snapshot?.onlineFriends ?? [])
  const pairingForm = (
    <form
      className="flex flex-wrap items-end gap-3"
      onSubmit={(event) => {
        event.preventDefault()
        void pair()
      }}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <Label htmlFor="mirror-browser-password">{copy.password}</Label>
        <Input
          id="mirror-browser-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete="one-time-code"
          maxLength={64}
        />
      </div>
      <Button disabled={pairing || password.trim().length === 0}>
        {copy.pair}
      </Button>
    </form>
  )

  if (report)
    return (
      <ReportView
        data={report}
        onClose={() => connection.disconnect()}
        autoFocusClose
        topContent={
          state.status !== 'connected' || state.reportCached === false ? (
            <div className="mx-auto mb-4 max-w-md rounded-md border border-border-default bg-bg-raised p-4">
              {state.status !== 'connected' ? (
                <>
                  <p role="status" className="mb-3 text-sm text-text-secondary">
                    {copy.savedReport}
                  </p>
                  {pairingForm}
                  {state.error ? (
                    <p
                      role="alert"
                      className="mt-3 text-sm text-status-alerted"
                    >
                      {pairingError}
                    </p>
                  ) : null}
                </>
              ) : null}
              {state.reportCached === false ? (
                <p role="status" className="mt-3 text-sm text-text-secondary">
                  {copy.reportNotCached}
                </p>
              ) : null}
            </div>
          ) : undefined
        }
      />
    )

  if (!snapshot)
    return (
      <main className="flex min-h-full items-center justify-center bg-bg-base px-6 py-6 text-text-primary">
        <div className="flex w-full max-w-md flex-col gap-4 rounded-lg border border-border-default bg-bg-surface p-6">
          <h1 className="text-xl font-semibold">{copy.pairing}</h1>
          <p className="text-sm text-text-secondary">{copy.pairingHelp}</p>
          {state.status === 'connecting' ? (
            <Skeleton className="h-4 w-full" />
          ) : null}
          {state.error ? (
            <p role="alert" className="text-sm text-status-alerted">
              {pairingError}
            </p>
          ) : null}
          {state.snapshot && !snapshot ? (
            <p role="alert" className="text-sm text-status-alerted">
              {copy.invalidSnapshot}
            </p>
          ) : null}
          {pairingForm}
        </div>
      </main>
    )

  return (
    <main
      className="flex h-full flex-col bg-bg-base text-text-primary"
      aria-label={strings.session.mainAriaLabel}
    >
      <h1 className="sr-only">{strings.app.sessionSrHeading}</h1>
      {!connected ? (
        <div
          role="status"
          className="border-b border-border-default bg-bg-raised px-4 py-3 text-sm"
        >
          <p>{snapshot.status === 'ended' ? copy.ended : copy.disconnected}</p>
          <div className="mt-3 max-w-md">{pairingForm}</div>
          {state.error ? (
            <p role="alert" className="mt-2 text-status-alerted">
              {pairingError}
            </p>
          ) : null}
        </div>
      ) : null}
      {snapshot.controlError ? (
        <div
          role="alert"
          className="flex items-center justify-between gap-3 border-b border-border-default bg-bg-raised px-4 py-3 text-sm"
        >
          <p>{snapshot.controlError}</p>
          <Button
            variant="ghost"
            size="sm"
            disabled={!connected}
            onClick={() => control({ type: 'dismiss_error' })}
          >
            {copy.dismissError}
          </Button>
        </div>
      ) : null}
      {snapshot.offlineImagesOmitted ? (
        <p className="px-4 py-2 text-xs text-text-secondary">
          {copy.offlineImages}
        </p>
      ) : null}
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <div className="flex min-h-0 flex-1 flex-col gap-3 px-4 py-4">
          {mediaError ? (
            <MediaErrorBanner
              errorName={mediaError}
              onRetry={() => acquireCamera()}
            />
          ) : null}
          {connected && !camera ? (
            <div className="flex flex-wrap items-center gap-3">
              <Button disabled={cameraBusy} onClick={() => acquireCamera()}>
                {copy.enableMedia}
              </Button>
              <p className="text-sm text-text-secondary">{copy.mediaHelp}</p>
            </div>
          ) : null}
          <VideoGrid className="min-h-0 flex-1">
            {snapshot.tiles.map((tile) => (
              <VideoTile
                key={tile.key}
                name={tile.name}
                stream={tileStream(tile.key)}
                variant={tile.variant}
                isLocal={tile.local}
                state={tile.state}
                ptt={tile.local ? talking : tile.ptt}
                cameraOff={tile.cameraOff}
                alertReasoning={tile.alertReasoning}
                sinkId={outputDevice ?? undefined}
                volume={
                  tile.local || tile.variant === 'screen'
                    ? undefined
                    : (volumes[tile.key] ?? 1)
                }
                onVolumeChange={
                  tile.local
                    ? undefined
                    : (volume) =>
                        setVolumes((current) => ({
                          ...current,
                          [tile.key]: volume,
                        }))
                }
                onExpand={
                  tile.variant === 'screen'
                    ? () => setExpandedScreen(tile.key)
                    : undefined
                }
              />
            ))}
            {Object.keys(snapshot.peers).length === 0 ? (
              <WaitingTile variant={snapshot.hadAnyPeer ? 'solo' : 'invite'} />
            ) : null}
          </VideoGrid>
        </div>
        <aside className="flex h-80 min-h-0 shrink-0 flex-col lg:h-auto lg:w-80">
          <AuditLogPanel
            events={snapshot.audit}
            className="h-auto min-h-0 flex-1"
          />
          <SessionNotesPanel
            notes={snapshot.notes}
            images={images}
            resolveName={resolveName}
            onSend={(text) => control({ type: 'note', text })}
            onSendImage={(file) => {
              try {
                // I129 — file conversion belongs to the session that accepted the gesture.
                const epoch = mediaScopeRef.current
                const sessionId = snapshot.sessionId
                validateOutgoingImage(file)
                void blobToBase64(file)
                  .then((data) => {
                    if (!currentSession(epoch, sessionId)) return
                    control({
                      type: 'image',
                      filename: file.name,
                      mimeType: file.type,
                      data,
                    })
                  })
                  .catch(() => toast.error(strings.session.images.sendFailed))
              } catch {
                toast.error(strings.session.images.tooLarge)
              }
            }}
            onOpenImage={(image) => setImageId(image.id)}
            mirror={{
              sessionId: snapshot.sessionId,
              peers: snapshot.peers,
              aiAvailable: snapshot.aiAvailable,
              chat: snapshot.chat,
              disabled: !connected,
              controls: {
                sendDirectMessage: async (recipient, text) =>
                  control({ type: 'direct_message', recipient, text }),
                sendAi: async (text) => control({ type: 'ai_message', text }),
              },
            }}
          />
        </aside>
      </div>
      <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-border-subtle bg-bg-surface px-4 py-3 text-sm">
        <fieldset
          disabled={!connected}
          className="flex flex-wrap items-center gap-2"
        >
          <Button
            variant={talking ? 'secondary' : 'ghost'}
            size="sm"
            aria-pressed={talking}
            aria-label={strings.session.holdToTalkAriaLabel}
            disabled={!camera}
            onPointerDown={(event) => {
              if (!event.isPrimary || event.button !== 0) return
              event.currentTarget.setPointerCapture(event.pointerId)
              startTalking()
            }}
            onPointerUp={stopTalking}
            onPointerCancel={stopTalking}
            onLostPointerCapture={stopTalking}
            onBlur={stopTalking}
            onKeyDown={(event) => {
              if (
                !event.repeat &&
                (event.key === ' ' || event.key === 'Enter')
              ) {
                event.preventDefault()
                startTalking()
              }
            }}
            onKeyUp={(event) => {
              if (event.key === ' ' || event.key === 'Enter') stopTalking()
            }}
          >
            {talking ? <MicIcon /> : <MicOffIcon />}
            {talking
              ? strings.session.talkingCta
              : strings.session.holdToTalkCta}
          </Button>
          <AudioDevicePicker
            currentDeviceId={audioDevice}
            onSelect={(id) => {
              setAudioDevice(id)
              acquireCamera(id)
            }}
            swapping={cameraBusy}
          />
          <AudioOutputPicker
            currentDeviceId={outputDevice}
            onSelect={setOutputDevice}
          />
          <Button
            size="sm"
            variant="ghost"
            aria-label={strings.session.camera.toggleAriaLabel}
            aria-pressed={snapshot.cameraOn}
            onClick={() => {
              for (const track of camera?.getVideoTracks() ?? [])
                track.enabled = !snapshot.cameraOn
              control({ type: 'camera', on: !snapshot.cameraOn })
            }}
          >
            {snapshot.cameraOn ? <VideoIcon /> : <VideoOffIcon />}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            aria-label={strings.session.screenShare.toggleAriaLabel}
            aria-pressed={snapshot.screenSharing}
            disabled={
              screenBusy ||
              typeof navigator.mediaDevices?.getDisplayMedia !== 'function'
            }
            onClick={() => {
              if (snapshot.screenSharing)
                control({ type: 'screen_sharing', sharing: false })
              else if (screen)
                control({ type: 'screen_sharing', sharing: true })
              else acquireScreen(true)
            }}
          >
            {snapshot.screenSharing ? (
              <>
                <ScreenShareOffIcon />
                {strings.session.screenShare.stopCta}
              </>
            ) : (
              <ScreenShareIcon />
            )}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            aria-label={copy.aiAction}
            disabled={!snapshot.aiAvailable}
            onClick={() => setAiOpen(true)}
          >
            <BotIcon />
          </Button>
        </fieldset>
        <div className="flex flex-wrap items-center gap-3">
          <AiStatusChip status={snapshot.aiStatus} />
          <span className="font-mono text-text-secondary">
            {copy.elapsed(Math.floor(snapshot.elapsedMs / 60_000))}
          </span>
          <fieldset disabled={!connected}>
            <SessionTimer
              {...snapshot.pomodoro}
              onStart={(args) => control({ type: 'pomodoro_start', args })}
              onStop={() => control({ type: 'pomodoro_stop' })}
            />
          </fieldset>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="ghost"
            aria-label={strings.settings.openAriaLabel}
            onClick={() => {
              setTopicDraft(snapshot.declaredTopic)
              setSettingsOpen(true)
            }}
          >
            <Settings2Icon />
          </Button>
          {snapshot.canInvite ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={!connected}
              onClick={() => setInviteOpen(true)}
            >
              {strings.session.invite.cta}
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="secondary"
            disabled={!connected}
            onClick={() => control({ type: 'leave' })}
          >
            {strings.session.leaveCta}
          </Button>
        </div>
      </footer>
      {snapshot.warning && !snapshot.breakEndsAt ? (
        <SelfWarningBadge
          reasoning={snapshot.warning.reasoning}
          onDismiss={() => control({ type: 'dismiss_warning' })}
        />
      ) : null}
      {snapshot.breakEndsAt ? (
        <BreakCountdownBadge endsAt={snapshot.breakEndsAt} />
      ) : null}
      <ScreenShareViewer
        open={expandedStream !== null}
        onOpenChange={(open) => {
          if (!open) setExpandedScreen(null)
        }}
        stream={expandedStream}
        name={expandedTile?.name ?? ''}
      />
      <SessionImageViewer
        image={openImage}
        onOpenChange={(open) => {
          if (!open) setImageId(null)
        }}
        resolveName={resolveName}
      />
      <SessionInviteDialog
        open={inviteOpen}
        onOpenChange={setInviteOpen}
        friends={snapshot.friends}
        isOnline={(key) => online.has(key)}
        inSessionEdPubkeys={
          new Set(
            Object.values(snapshot.peers).flatMap((peer) =>
              peer.edPubkeyHex ? [peer.edPubkeyHex] : []
            )
          )
        }
        full={snapshot.sessionFull}
        onInvite={async (friend) => {
          control({ type: 'invite', edPubkeyHex: friend.ed_pubkey_hex })
          return true
        }}
      />
      <Dialog open={aiOpen} onOpenChange={setAiOpen}>
        <DialogContent aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>{copy.aiAction}</DialogTitle>
          </DialogHeader>
          <AiTextBox
            value={aiText}
            onChange={setAiText}
            pending={snapshot.aiAction?.pending}
            onSubmit={() => {
              if (!connected || !aiText.trim()) return
              control({ type: 'ai_action', text: aiText.trim().slice(0, 500) })
              setAiText('')
            }}
          />
          {snapshot.aiAction?.text ? (
            <AiResponseBubble
              text={snapshot.aiAction.text}
              tone={snapshot.aiAction.tone}
            />
          ) : null}
        </DialogContent>
      </Dialog>
      <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
        <DialogContent
          className="max-h-[90vh] overflow-y-auto"
          aria-describedby={undefined}
        >
          <DialogHeader>
            <DialogTitle>{copy.controls}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            <form
              className="flex flex-col gap-2"
              onSubmit={(event) => {
                event.preventDefault()
                if (topicDraft.trim())
                  control({
                    type: 'topic',
                    topic: topicDraft.trim().slice(0, 120),
                  })
              }}
            >
              <Label htmlFor="mirror-topic">{copy.topic}</Label>
              <Input
                id="mirror-topic"
                value={topicDraft}
                maxLength={120}
                onChange={(event) => setTopicDraft(event.target.value)}
                disabled={!connected}
              />
              <Button disabled={!connected || topicDraft.trim().length === 0}>
                {copy.updateTopic}
              </Button>
            </form>
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="mirror-ai-enabled">{copy.aiEnable}</Label>
              <Switch
                id="mirror-ai-enabled"
                checked={snapshot.aiEnabled}
                disabled={!connected}
                onCheckedChange={(enabled) => {
                  if (enabled && snapshot.aiEnableNeedsConsent)
                    setAiConsentOpen(true)
                  else control({ type: 'ai_enabled', enabled })
                }}
              />
            </div>
            <p className="text-sm text-text-secondary">{copy.aiToggleHelp}</p>
            {typeof navigator.mediaDevices?.getDisplayMedia === 'function' ? (
              <>
                <p className="text-sm text-text-secondary">{copy.screenHelp}</p>
                <Button
                  disabled={!connected || screenBusy}
                  onClick={() => (screen ? stopScreen() : acquireScreen(false))}
                >
                  {screen ? copy.screenStop : copy.screenCapture}
                </Button>
              </>
            ) : (
              <p className="text-sm text-text-secondary">
                {copy.screenUnavailable}
              </p>
            )}
            <Button variant="secondary" onClick={enableAudio}>
              {copy.enableAudio}
            </Button>
            <Button variant="secondary" onClick={() => void notifications()}>
              {copy.notifications}
            </Button>
            {notificationHelp ? (
              <p role="status" className="text-sm text-text-secondary">
                {notificationHelp}
              </p>
            ) : null}
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="mirror-awake">{copy.keepAwake}</Label>
              <Switch
                id="mirror-awake"
                checked={awake}
                disabled={!connected}
                onCheckedChange={(next) => void toggleAwake(next)}
              />
            </div>
            <Button
              variant="secondary"
              onClick={() => {
                stopTalking()
                connection.disconnect()
                setSettingsOpen(false)
              }}
            >
              {copy.disconnect}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={aiConsentOpen} onOpenChange={setAiConsentOpen}>
        <DialogContent aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>
              {strings.settings.ai.benchmarkWarning.title}
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-text-secondary">
            {strings.settings.ai.benchmarkWarning.description(
              strings.settings.ai.benchmarkWarning.fallbackModelName,
              5
            )}
          </p>
          <p className="text-sm text-text-secondary">
            {strings.settings.ai.benchmarkWarning.recommendation}
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setAiConsentOpen(false)}>
              {strings.settings.ai.benchmarkWarning.keepOffCta}
            </Button>
            <Button
              disabled={!connected}
              onClick={() => {
                control({ type: 'ai_enabled', enabled: true, consent: true })
                setAiConsentOpen(false)
              }}
            >
              {strings.settings.ai.benchmarkWarning.enableAnywayCta}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </main>
  )
}
