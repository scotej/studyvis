import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

import { createMirrorPeer, type MirrorPeer } from './peer'
import type { MirrorAppRuntime } from './appRuntime'
import { parseMirrorControl } from './sessionBridge'
import {
  MirrorCodec,
  type CaptureKind,
  type MirrorConfig,
  type MirrorMessage,
  type MirrorNotification,
} from './wire'

export type MirrorHostOptions = {
  onControl: (control: unknown) => boolean | void | Promise<boolean | void>
  onCapture: (kind: CaptureKind, stream: MediaStream | null) => void
  onConnected: (connected: boolean) => void
  app?: MirrorAppRuntime
}

export type MirrorHost = {
  start: (
    sessionId: string | null,
    scope?: 'session' | 'app'
  ) => Promise<MirrorConfig>
  stop: () => Promise<void>
  publish: (snapshot: unknown) => void
  setStreams: (streams: Record<string, MediaStream>) => void
  sendNotification: (notification: MirrorNotification) => void
  finishReport: (report: unknown) => Promise<void>
  retireSession: () => void
}

type Client = {
  id: string
  codec: MirrorCodec
  peer: MirrorPeer | null
  queue: Promise<void>
  appProtocol: boolean
  ownerEpoch: string | null
  activationId: string | null
  legacySession: string | null
  legacyRetired: boolean
}

export function createMirrorHost(options: MirrorHostOptions): MirrorHost {
  let generation = 0
  let active = false
  let starting = false
  let scope: 'session' | 'app' = 'session'
  let requestId: string | null = null
  let unlisten: UnlistenFn[] = []
  let client: Client | null = null
  let streams: Record<string, MediaStream> = {}
  let snapshot: unknown = null
  let pendingSnapshot = false
  let publishing = false
  let reportSaved: (() => void) | null = null
  let finishing = false
  let legacyLeaseRetired = false

  const disconnect = () => {
    const old = client
    client = null
    old?.peer?.close()
    if (old) options.app?.retireController(old.id)
    options.onCapture('camera', null)
    options.onCapture('screen', null)
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
    if (current)
      void send({ type: 'reconnect' }).then(() => {
        if (client === current) disconnect()
      })
  }

  const makePeer = (current: Client) => {
    const ownerEpoch = current.ownerEpoch
    const activationId = current.activationId
    const peer = createMirrorPeer({
      role: 'host',
      send: (signal) => {
        if (client !== current || current.peer !== peer) return
        if (current.appProtocol) {
          if (ownerEpoch && activationId)
            void send({
              type: 'app_signal',
              ownerEpoch,
              sessionActivationId: activationId,
              signal,
            })
        } else void send({ type: 'signal', signal })
      },
      onCapture: (kind, capture) => {
        if (client !== current || current.peer !== peer) return
        if (
          current.appProtocol &&
          (current.ownerEpoch !== ownerEpoch ||
            current.activationId !== activationId)
        )
          return
        options.onCapture(kind, capture)
      },
      onFailure: recover,
    })
    current.peer = peer
    peer.setStreams(streams)
  }

  const publishLatest = async () => {
    if (publishing) return
    publishing = true
    try {
      while (pendingSnapshot && active && client && !finishing) {
        pendingSnapshot = false
        if (scope === 'app' && !client.appProtocol) {
          const id =
            snapshot && typeof snapshot === 'object' && 'sessionId' in snapshot
              ? snapshot.sessionId
              : null
          if (
            typeof id !== 'string' ||
            client.legacyRetired ||
            legacyLeaseRetired
          )
            continue
          if (client.legacySession !== null && client.legacySession !== id) {
            client.legacyRetired = true
            continue
          }
          client.legacySession = id
        }
        if (snapshot !== null) await send({ type: 'snapshot', snapshot })
      }
    } finally {
      publishing = false
    }
  }

  const publishApp = async () => {
    const current = client
    const next = options.app?.getSnapshot()
    if (!active || scope !== 'app' || !current?.appProtocol || !next) return
    const changed =
      current.ownerEpoch !== next.ownerEpoch ||
      current.activationId !== next.sessionActivationId
    if (changed) {
      current.peer?.close()
      current.peer = null
      current.ownerEpoch = next.ownerEpoch
      current.activationId = next.sessionActivationId
      options.onCapture('camera', null)
      options.onCapture('screen', null)
    }
    await send({ type: 'app_snapshot', snapshot: next })
    if (
      client !== current ||
      !active ||
      current.ownerEpoch !== next.ownerEpoch ||
      current.activationId !== next.sessionActivationId
    )
      return
    if (next.sessionActivationId !== null && !current.peer) makePeer(current)
    pendingSnapshot = true
    void publishLatest()
  }

  const retireSession = () => {
    streams = {}
    snapshot = null
    pendingSnapshot = false
    finishing = false
    reportSaved?.()
    reportSaved = null
    if (client) {
      client.peer?.close()
      client.peer = null
      client.legacyRetired = true
    }
    options.onCapture('camera', null)
    options.onCapture('screen', null)
    legacyLeaseRetired = true
    options.app?.retireSession()
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
    options.app?.reset()
    if (stoppedRequest)
      await invoke('mirror_stop', { requestId: stoppedRequest })
  }

  return {
    async start(sessionId, nextScope = 'session') {
      if (active || starting) throw new Error('Mirroring is already enabled')
      if (nextScope === 'app' && !options.app)
        throw new Error('App access requires a companion app controller')
      if (nextScope === 'session' && !sessionId)
        throw new Error('Session access requires an active session')
      scope = nextScope
      legacyLeaseRetired = false
      starting = true
      finishing = false
      const run = ++generation
      const startedRequest = crypto.randomUUID()
      requestId = startedRequest
      const listeners: UnlistenFn[] = []
      try {
        if (scope === 'app' && options.app) {
          let previous = options.app.getSnapshot()
          listeners.push(
            options.app.register('session.control', {
              parse: (raw) => parseMirrorControl(raw),
              requiresSession: true,
              mutates: true,
              available: () => !finishing,
              execute: async (control, context) => ({
                accepted:
                  (await context.commit(() => options.onControl(control))) ===
                  true,
              }),
            })
          )
          listeners.push(
            options.app.subscribe(() => {
              const next = options.app!.getSnapshot()
              if (previous && next && previous.ownerEpoch !== next.ownerEpoch) {
                void stop()
                return
              }
              if (previous?.sessionActivationId !== next?.sessionActivationId) {
                streams = {}
                snapshot = null
                finishing = false
                if (previous && previous.sessionActivationId !== null) {
                  legacyLeaseRetired = true
                  if (client && !client.appProtocol) {
                    client.peer?.close()
                    client.peer = null
                    client.legacyRetired = true
                  }
                }
              }
              previous = next
              void publishApp()
            })
          )
          listeners.push(
            options.app.subscribeJobs((job) => {
              if (client?.appProtocol) void send({ type: 'app_job', job })
            })
          )
          listeners.push(
            await listen<{ requestId: string }>(
              'mirror:session-ended',
              ({ payload }) => {
                if (
                  active &&
                  run === generation &&
                  requestId === payload.requestId
                )
                  retireSession()
              }
            )
          )
        }
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
              const current: Client = {
                id: payload.clientId,
                codec: new MirrorCodec(),
                peer: null,
                queue: Promise.resolve(),
                appProtocol: false,
                ownerEpoch: null,
                activationId: null,
                legacySession: null,
                legacyRetired: scope === 'app' && legacyLeaseRetired,
              }
              client = current
              if (scope === 'session') makePeer(current)
              options.onConnected(true)
              if (scope === 'session') {
                pendingSnapshot = true
                void publishLatest()
              }
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
                    if (!client.appProtocol && !client.legacyRetired)
                      client.peer?.receive(message.signal)
                    break
                  case 'app_signal':
                    if (
                      client.appProtocol &&
                      message.ownerEpoch === client.ownerEpoch &&
                      message.sessionActivationId === client.activationId
                    )
                      client.peer?.receive(message.signal)
                    break
                  case 'app_request': {
                    if (!client.appProtocol || !options.app || scope !== 'app')
                      break
                    const controller = client
                    void options.app
                      .handle(
                        message.request,
                        controller.id,
                        () =>
                          active && client === controller && run === generation
                      )
                      .then((result) => {
                        if (
                          result &&
                          active &&
                          client === controller &&
                          run === generation
                        )
                          return send({ type: 'app_result', result })
                      })
                      .catch(() => {})
                    break
                  }
                  case 'control': {
                    const controller = client
                    void Promise.resolve()
                      .then(() => {
                        if (
                          client !== controller ||
                          run !== generation ||
                          !active ||
                          finishing ||
                          controller.appProtocol ||
                          controller.legacyRetired
                        )
                          return false
                        return options.onControl(message.control)
                      })
                      .catch(() => false)
                      .then((result) => {
                        if (
                          message.requestId &&
                          client === controller &&
                          run === generation &&
                          active &&
                          !finishing
                        )
                          return send({
                            type: 'control_result',
                            requestId: message.requestId,
                            ok: result === true,
                          })
                      })
                    break
                  }
                  case 'ready':
                    if (scope === 'app' && message.appProtocol === 1) {
                      client.appProtocol = true
                      void publishApp()
                    } else {
                      if (scope === 'app' && legacyLeaseRetired) break
                      if (!client.peer) makePeer(client)
                      client.peer?.setStreams(streams)
                      pendingSnapshot = true
                      void publishLatest()
                    }
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
          ...(scope === 'app' ? { scope: 'app' } : {}),
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
    retireSession,
    publish(next) {
      if (finishing) return
      snapshot = next
      pendingSnapshot = true
      void publishLatest()
    },
    setStreams(next) {
      if (!finishing) {
        streams = next
        client?.peer?.setStreams(next)
      }
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
