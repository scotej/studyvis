import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

import { createMirrorPeer, type MirrorPeer } from './peer'
import {
  MirrorCodec,
  type CaptureKind,
  type MirrorConfig,
  type MirrorMessage,
  type MirrorNotification,
} from './wire'

export type MirrorHostOptions = {
  onControl: (control: unknown) => void | Promise<void>
  onCapture: (kind: CaptureKind, stream: MediaStream | null) => void
  onConnected: (connected: boolean) => void
}

export type MirrorHost = {
  start: (sessionId: string) => Promise<MirrorConfig>
  stop: () => Promise<void>
  publish: (snapshot: unknown) => void
  setStreams: (streams: Record<string, MediaStream>) => void
  sendNotification: (notification: MirrorNotification) => void
  finishReport: (report: unknown) => Promise<void>
}

export function createMirrorHost(options: MirrorHostOptions): MirrorHost {
  let generation = 0
  let active = false
  let starting = false
  let requestId: string | null = null
  let unlisten: UnlistenFn[] = []
  let client: {
    id: string
    codec: MirrorCodec
    peer: MirrorPeer
    queue: Promise<void>
  } | null = null
  let streams: Record<string, MediaStream> = {}
  let snapshot: unknown = null
  let pendingSnapshot = false
  let publishing = false
  let reportSaved: (() => void) | null = null
  let finishing = false

  const disconnect = () => {
    const old = client
    client = null
    old?.peer.close()
    reportSaved?.()
    reportSaved = null
    options.onConnected(false)
  }

  const send = (message: MirrorMessage): Promise<void> => {
    const current = client
    if (!current || !active) return Promise.resolve()
    const job = current.queue.then(async () => {
      if (client !== current || !active) return
      if (message.type === 'snapshot' && finishing) return
      await current.codec.send(message, async (data) => {
        if (client !== current || !active)
          throw new Error('Mirror client disconnected')
        await invoke('mirror_send', { clientId: current.id, data })
      })
    })
    current.queue = job.catch(() => {
      if (client === current) disconnect()
    })
    return current.queue
  }

  const recover = () => {
    const current = client
    if (!current) return
    void send({ type: 'reconnect' }).then(() => {
      if (client === current) disconnect()
    })
  }

  const publishLatest = async () => {
    if (publishing) return
    publishing = true
    try {
      while (pendingSnapshot && active && client && !finishing) {
        pendingSnapshot = false
        await send({ type: 'snapshot', snapshot })
      }
    } finally {
      publishing = false
    }
  }

  const stop = async () => {
    const stoppedRequest = requestId
    requestId = null
    generation++
    active = false
    starting = false
    for (const off of unlisten) off()
    unlisten = []
    disconnect()
    if (stoppedRequest)
      await invoke('mirror_stop', { requestId: stoppedRequest })
  }

  return {
    async start(sessionId) {
      if (active || starting) throw new Error('Mirroring is already enabled')
      starting = true
      finishing = false
      const run = ++generation
      const startedRequest = crypto.randomUUID()
      requestId = startedRequest
      const listeners: UnlistenFn[] = []
      try {
        listeners.push(
          await listen<{ clientId: string; connected: boolean }>(
            'mirror:client',
            ({ payload }) => {
              if (run !== generation || !active) return
              if (!payload.connected) {
                if (client?.id === payload.clientId) disconnect()
                return
              }
              disconnect()
              const codec = new MirrorCodec()
              const peer = createMirrorPeer({
                role: 'host',
                send: (signal) => {
                  void send({ type: 'signal', signal })
                },
                onCapture: options.onCapture,
                onFailure: recover,
              })
              client = {
                id: payload.clientId,
                codec,
                peer,
                queue: Promise.resolve(),
              }
              peer.setStreams(streams)
              options.onConnected(true)
              pendingSnapshot = true
              void publishLatest()
            }
          )
        )
        listeners.push(
          await listen<{ clientId: string; data: string }>(
            'mirror:message',
            ({ payload }) => {
              if (
                run !== generation ||
                !active ||
                payload.clientId !== client?.id
              )
                return
              try {
                const message = client.codec.receive(payload.data)
                if (!message) return
                switch (message.type) {
                  case 'signal':
                    client.peer.receive(message.signal)
                    break
                  case 'control':
                    void Promise.resolve(
                      options.onControl(message.control)
                    ).catch(() => {
                      // Controls are validated and report errors through host UI.
                    })
                    break
                  case 'ready':
                    client.peer.setStreams(streams)
                    pendingSnapshot = true
                    void publishLatest()
                    break
                  case 'ping':
                    void send({ type: 'pong' })
                    break
                  case 'report_saved':
                    reportSaved?.()
                    reportSaved = null
                    break
                  default:
                    break
                }
              } catch {
                recover()
              }
            }
          )
        )
        if (run !== generation) throw new Error('Mirroring was cancelled')
        unlisten = listeners
        const config = await invoke<MirrorConfig>('mirror_start', {
          sessionId,
          requestId: startedRequest,
        })
        if (run !== generation) {
          await invoke('mirror_stop', { requestId: startedRequest })
          throw new Error('Mirroring was cancelled')
        }
        active = true
        starting = false
        return config
      } catch (error) {
        for (const off of listeners) off()
        if (run === generation) {
          starting = false
          unlisten = []
          requestId = null
          await invoke('mirror_stop', { requestId: startedRequest }).catch(
            () => {}
          )
        }
        throw error
      }
    },
    stop,
    publish(next) {
      if (finishing) return
      snapshot = next
      pendingSnapshot = true
      void publishLatest()
    },
    setStreams(next) {
      if (finishing) return
      streams = next
      client?.peer.setStreams(next)
    },
    sendNotification(notification) {
      void send({ type: 'notification', ...notification })
    },
    async finishReport(report) {
      finishing = true
      pendingSnapshot = false
      if (!client) return
      let timeout: ReturnType<typeof setTimeout> | undefined
      const saved = new Promise<void>((resolve) => {
        reportSaved = resolve
      })
      await Promise.race([
        send({ type: 'report', report }).then(() => saved),
        new Promise<void>((resolve) => {
          timeout = setTimeout(resolve, 3000)
        }),
      ])
      clearTimeout(timeout)
      reportSaved = null
    },
  }
}
