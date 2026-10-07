import { stopMediaStream } from '@/lib/media'
import { createMirrorPeer, type MirrorPeer } from './peer'
import { MirrorCodec, type CaptureKind, type MirrorMessage } from './wire'
import { projectOfflineSnapshot, readMirrorSnapshot } from './sessionBridge'
import { readMirrorReport, type MirrorReport } from './reportValidation'

export type BrowserConnectionState = {
  status: 'pairing' | 'connecting' | 'connected' | 'disconnected'
  snapshot: unknown | null
  streams: Record<string, MediaStream>
  error: string | null
  report: MirrorReport | null
  reportCached?: boolean
}

export type BrowserConnection = {
  getState: () => BrowserConnectionState
  subscribe: (listener: (state: BrowserConnectionState) => void) => () => void
  pair: (password: string) => Promise<void>
  sendControl: (control: unknown) => void
  setCapture: (kind: CaptureKind, stream: MediaStream | null) => void
  disconnect: () => void
}

const SNAPSHOT_KEY = 'studyvis.mirror.snapshot.v1'
const REPORT_KEY = 'studyvis.mirror.report.v1'
const MAX_SAVED_SNAPSHOT = 2 * 1024 * 1024

export function createBrowserConnection(): BrowserConnection {
  let restored: unknown = null
  let restoredReport: MirrorReport | null = null
  try {
    const raw = localStorage.getItem(SNAPSHOT_KEY)
    if (raw && raw.length <= MAX_SAVED_SNAPSHOT) restored = JSON.parse(raw)
    const report = localStorage.getItem(REPORT_KEY)
    if (report && report.length <= MAX_SAVED_SNAPSHOT)
      restoredReport = readMirrorReport(JSON.parse(report))
  } catch {
    /* Private browsing can deny storage. */
  }
  let state: BrowserConnectionState = {
    status: restored || restoredReport ? 'disconnected' : 'pairing',
    snapshot: restored,
    streams: {},
    error: null,
    report: restoredReport,
    reportCached: restoredReport !== null,
  }
  const listeners = new Set<(state: BrowserConnectionState) => void>()
  const captures: Record<CaptureKind, MediaStream | null> = {
    camera: null,
    screen: null,
  }
  let socket: WebSocket | null = null
  let peer: MirrorPeer | null = null
  let codec = new MirrorCodec()
  let queue = Promise.resolve()
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let heartbeat: ReturnType<typeof setInterval> | null = null
  let lastHeardAt = 0
  let retries = 0
  let stopped = false
  let connectionRun = 0
  let completedSessionId =
    restoredReport?.mirrorSessionId ?? restoredReport?.session.id ?? null

  const update = (patch: Partial<BrowserConnectionState>) => {
    state = { ...state, ...patch }
    for (const listener of listeners) listener(state)
  }

  const send = (message: MirrorMessage) => {
    const current = socket
    const currentCodec = codec
    queue = queue
      .then(async () => {
        if (
          !current ||
          current !== socket ||
          current.readyState !== WebSocket.OPEN
        )
          return
        await currentCodec.send(message, async (data) => {
          const deadline = Date.now() + 10_000
          while (current.bufferedAmount > 1024 * 1024) {
            if (
              Date.now() >= deadline ||
              current !== socket ||
              current.readyState !== WebSocket.OPEN
            ) {
              throw new Error('Mirror connection stalled')
            }
            await new Promise((resolve) => setTimeout(resolve, 20))
          }
          if (current !== socket || current.readyState !== WebSocket.OPEN)
            throw new Error('Mirror connection closed')
          current.send(data)
          // Keep image bursts below the host's ingress budget, while yielding to
          // camera rendering and permission UI on slower tablet devices.
          await new Promise((resolve) => setTimeout(resolve, 10))
        })
      })
      .catch(() => {
        if (socket === current) current?.close()
      })
  }

  const clearMedia = () => {
    peer?.close()
    peer = null
    for (const kind of ['camera', 'screen'] as const) {
      stopMediaStream(captures[kind])
      captures[kind] = null
    }
    update({ streams: {} })
  }

  const connect = () => {
    if (stopped) return
    const run = ++connectionRun
    if (reconnectTimer) clearTimeout(reconnectTimer)
    reconnectTimer = null
    codec = new MirrorCodec()
    const current = new WebSocket(
      `${location.origin.replace(/^https:/, 'wss:')}/api/socket`
    )
    socket = current
    update({ status: 'connecting', error: null })
    const openDeadline = setTimeout(() => current.close(), 15_000)
    current.onopen = () => {
      clearTimeout(openDeadline)
      if (run !== connectionRun || stopped) {
        current.close()
        return
      }
      retries = 0
      lastHeardAt = Date.now()
      peer = createMirrorPeer({
        role: 'browser',
        send: (signal) => send({ type: 'signal', signal }),
        onStreams: (streams) => update({ streams }),
        onFailure: () => current.close(),
      })
      for (const kind of ['camera', 'screen'] as const)
        peer.setCapture(kind, captures[kind])
      send({ type: 'ready' })
      heartbeat = setInterval(() => {
        if (Date.now() - lastHeardAt > 15_000) current.close()
        else send({ type: 'ping' })
      }, 5000)
    }
    current.onmessage = ({ data }: MessageEvent<unknown>) => {
      if (run !== connectionRun || typeof data !== 'string') return
      try {
        const message = codec.receive(data)
        lastHeardAt = Date.now()
        if (!message) return
        if (message.type === 'signal') peer?.receive(message.signal)
        else if (message.type === 'snapshot') {
          const snapshot = readMirrorSnapshot(message.snapshot)
          if (!snapshot) throw new Error('Incompatible mirror snapshot')
          if (snapshot.sessionId === completedSessionId) return
          completedSessionId = null
          update({
            snapshot,
            report: null,
            reportCached: false,
            status: 'connected',
          })
          try {
            const saved = JSON.stringify(projectOfflineSnapshot(snapshot))
            localStorage.removeItem(REPORT_KEY)
            if (saved.length <= MAX_SAVED_SNAPSHOT)
              localStorage.setItem(SNAPSHOT_KEY, saved)
            else localStorage.removeItem(SNAPSHOT_KEY)
          } catch {
            /* The live session does not depend on browser storage. */
          }
        } else if (message.type === 'report') {
          const report = readMirrorReport(message.report)
          if (report) {
            completedSessionId = report.mirrorSessionId ?? report.session.id
            clearMedia()
            let reportCached = false
            try {
              localStorage.removeItem(SNAPSHOT_KEY)
              localStorage.removeItem(REPORT_KEY)
              const saved = JSON.stringify(report)
              if (saved.length <= MAX_SAVED_SNAPSHOT) {
                localStorage.setItem(REPORT_KEY, saved)
                reportCached = true
              }
            } catch {
              /* The host keeps the durable session report. */
            }
            update({
              report,
              snapshot: null,
              reportCached,
              status: 'connected',
            })
            send({ type: 'report_saved' })
          }
        } else if (message.type === 'notification') {
          if (
            'Notification' in window &&
            Notification.permission === 'granted' &&
            !(
              message.onlyWhenHidden &&
              typeof document !== 'undefined' &&
              document.visibilityState === 'visible' &&
              document.hasFocus()
            )
          ) {
            const show = async () => {
              const registration =
                await navigator.serviceWorker?.getRegistration()
              if (registration)
                await registration.showNotification(message.title, {
                  body: message.body,
                })
              else new Notification(message.title, { body: message.body })
            }
            void show().catch(() => {
              /* Notification denial must not disconnect media. */
            })
          }
        } else if (message.type === 'ping') send({ type: 'pong' })
        else if (message.type === 'reconnect') current.close()
      } catch {
        current.close()
      }
    }
    current.onclose = (event) => {
      clearTimeout(openDeadline)
      if (run !== connectionRun) return
      if (heartbeat) clearInterval(heartbeat)
      heartbeat = null
      socket = null
      clearMedia()
      if (event?.code === 4001) {
        stopped = true
        update({ status: 'disconnected', error: 'session_moved' })
      } else update({ status: stopped ? 'pairing' : 'disconnected' })
      if (!stopped)
        reconnectTimer = setTimeout(
          connect,
          Math.min(10_000, 1000 * 2 ** retries++)
        )
    }
    current.onerror = () => {
      /* onclose owns recovery; browsers redact TLS errors. */
    }
  }

  // A valid HttpOnly lease survives reload; an expired lease stays read-only
  // until the user supplies the fresh password shown on the desktop.
  if (window.isSecureContext && location.protocol === 'https:') connect()

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    async pair(password) {
      const response = await fetch('/api/pair', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        cache: 'no-store',
        body: JSON.stringify({
          password: password.replace(/[\s-]/g, '').toUpperCase(),
        }),
      })
      if (!response.ok) {
        update({
          error:
            response.status === 429
              ? 'rate_limited'
              : response.status === 409
                ? 'in_use'
                : 'pair_failed',
        })
        throw new Error('Pairing failed')
      }
      stopped = false
      connectionRun++
      socket?.close()
      if (heartbeat) clearInterval(heartbeat)
      heartbeat = null
      clearMedia()
      connect()
    },
    sendControl(control) {
      if (state.status === 'connected') send({ type: 'control', control })
    },
    setCapture(kind, stream) {
      if (state.status !== 'connected') {
        stopMediaStream(stream)
        return
      }
      const previous = captures[kind]
      captures[kind] = stream
      peer?.setCapture(kind, stream)
      if (previous !== stream) stopMediaStream(previous)
      for (const track of stream?.getTracks() ?? []) {
        track.addEventListener(
          'ended',
          () => {
            if (captures[kind] !== stream) return
            captures[kind] = null
            peer?.setCapture(kind, null)
            stopMediaStream(stream)
          },
          { once: true }
        )
      }
    },
    disconnect() {
      stopped = true
      completedSessionId = null
      connectionRun++
      if (reconnectTimer) clearTimeout(reconnectTimer)
      if (heartbeat) clearInterval(heartbeat)
      reconnectTimer = null
      heartbeat = null
      socket?.close()
      socket = null
      clearMedia()
      update({
        status: 'pairing',
        snapshot: null,
        error: null,
        report: null,
        reportCached: false,
      })
      try {
        localStorage.removeItem(SNAPSHOT_KEY)
        localStorage.removeItem(REPORT_KEY)
      } catch {
        /* unavailable */
      }
    },
  }
}
