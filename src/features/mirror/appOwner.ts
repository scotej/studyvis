import { createMirrorAppRuntime } from './appRuntime'
import type { MirrorAppSnapshot } from './appBridge'
import type { MirrorHost, MirrorHostOptions } from './runtime'
import type { MirrorConfig, MirrorNotification } from './wire'
import {
  parseMirrorControl,
  type MirrorControl,
  type MirrorSessionSnapshot,
} from './sessionBridge'

export type MirrorOwnerSource = {
  identity: { edPubkeyHex: string; displayName: string } | null
  phase: MirrorAppSnapshot['phase']
  room: object | null
  topic: string | null
}

export type MirrorOperationScope = {
  signal: AbortSignal
  isCurrent: () => boolean
  pinSession: () => void
  release: () => void
}

export function createMirrorAppOwner(deps: {
  createHost: (options: MirrorHostOptions) => MirrorHost
  registerReport: (
    topic: string,
    host: MirrorHost,
    activation: string
  ) => () => void
  registerNotifications?: (host: MirrorHost) => () => void
  id?: () => string
}) {
  const id = deps.id ?? (() => crypto.randomUUID())
  const runtime = createMirrorAppRuntime()
  const listeners = new Set<() => void>()
  const scopes = new Set<{
    abort: AbortController
    activation?: string | null
  }>()
  let source: MirrorOwnerSource = {
    identity: null,
    phase: 'loading',
    room: null,
    topic: null,
  }
  let host: MirrorHost | null = null
  let unregisterReport: (() => void) | undefined
  let unregisterNotifications: (() => void) | undefined
  let port: {
    topic: string
    control: (
      control: MirrorControl
    ) => boolean | void | Promise<boolean | void>
  } | null = null
  let revision = 0
  let ownerEpoch = id()
  let run = 0
  let state = {
    enabled: false,
    config: null as MirrorConfig | null,
    starting: false,
    connected: false,
    camera: null as MediaStream | null,
    screen: null as MediaStream | null,
    activationId: null as string | null,
    controllerRevision: 0,
  }
  const notify = () => {
    for (const listener of listeners) listener()
  }
  const updateState = (next: Partial<typeof state>) => {
    state = { ...state, ...next }
    notify()
  }
  const revokeOperations = () => {
    for (const scope of scopes) scope.abort.abort()
    scopes.clear()
  }
  const publishApp = () =>
    runtime.setSnapshot({
      version: 1,
      ownerEpoch,
      revision: ++revision,
      phase: source.phase,
      identity: source.identity,
      sessionActivationId: state.activationId,
    })
  const retire = () => {
    host?.retireSession()
    updateState({ camera: null, screen: null })
    port = null
  }
  const report = () => {
    unregisterReport?.()
    unregisterReport = undefined
    if (host && source.topic && state.activationId)
      unregisterReport = deps.registerReport(
        source.topic,
        host,
        state.activationId
      )
  }
  const stop = async () => {
    ++run
    const previous = host
    host = null
    revokeOperations()
    port?.control({ type: 'ptt', active: false })
    unregisterReport?.()
    unregisterReport = undefined
    unregisterNotifications?.()
    unregisterNotifications = undefined
    updateState({
      enabled: false,
      config: null,
      starting: false,
      connected: false,
      camera: null,
      screen: null,
      controllerRevision: state.controllerRevision + 1,
    })
    await previous?.stop()
    // stop resets A's runtime; reinstall the current public snapshot so the
    // same owner can be explicitly enabled again without a Home remount.
    if (!host) publishApp()
  }
  publishApp()
  return {
    runtime,
    getState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    update(next: MirrorOwnerSource) {
      const identityChanged =
        source.identity?.edPubkeyHex !== next.identity?.edPubkeyHex
      const activationChanged =
        source.room !== next.room ||
        (source.phase === 'session') !== (next.phase === 'session')
      const changed =
        identityChanged ||
        activationChanged ||
        source.phase !== next.phase ||
        source.topic !== next.topic ||
        source.identity?.displayName !== next.identity?.displayName
      source = next
      if (identityChanged) {
        ownerEpoch = id()
        void stop()
      }
      if (activationChanged) {
        if (state.activationId) retire()
        const activationId = next.phase === 'session' && next.room ? id() : null
        updateState({ activationId, camera: null, screen: null })
        for (const scope of scopes)
          if (
            scope.activation !== undefined &&
            scope.activation !== activationId
          )
            scope.abort.abort()
        report()
      }
      if (changed) publishApp()
    },
    touch: publishApp,
    operationScope(): MirrorOperationScope {
      const epoch = ownerEpoch
      const controller = state.controllerRevision
      const entry = {
        abort: new AbortController(),
        activation: undefined as string | null | undefined,
      }
      scopes.add(entry)
      return {
        signal: entry.abort.signal,
        isCurrent: () =>
          !entry.abort.signal.aborted &&
          state.enabled &&
          state.connected &&
          ownerEpoch === epoch &&
          state.controllerRevision === controller &&
          (entry.activation === undefined ||
            entry.activation === state.activationId),
        pinSession: () => {
          if (entry.activation === undefined)
            entry.activation = state.activationId
        },
        release: () => {
          scopes.delete(entry)
        },
      }
    },
    async start() {
      if (host || !source.identity) return
      const generation = ++run
      updateState({ enabled: true, starting: true })
      const created = deps.createHost({
        app: runtime,
        onControl(raw) {
          const control = parseMirrorControl(raw)
          return host === created &&
            source.phase === 'session' &&
            port?.topic === source.topic &&
            control
            ? port.control(control)
            : false
        },
        onCapture(kind, stream) {
          if (host !== created) return
          updateState(
            kind === 'camera' ? { camera: stream } : { screen: stream }
          )
        },
        onConnected(connected) {
          if (host !== created) return
          revokeOperations()
          if (!connected) {
            port?.control({ type: 'ptt', active: false })
            port?.control({ type: 'screen_sharing', sharing: false })
          }
          updateState({
            connected,
            controllerRevision: state.controllerRevision + 1,
          })
        },
      })
      host = created
      try {
        const config = await created.start(null, 'app')
        if (generation !== run || host !== created) {
          await created.stop()
          return
        }
        updateState({ config, starting: false })
        report()
        unregisterNotifications = deps.registerNotifications?.(created)
      } catch (error) {
        if (host === created) await stop()
        throw error
      }
    },
    stop,
    attach(
      topic: string,
      control: (
        control: MirrorControl
      ) => boolean | void | Promise<boolean | void>
    ) {
      const registration = { topic, control }
      port = registration
      return () => {
        if (port === registration) {
          port = null
          host?.setStreams({})
        }
      }
    },
    publish(snapshot: MirrorSessionSnapshot) {
      if (
        source.phase === 'session' &&
        snapshot.sessionId === state.activationId
      )
        host?.publish(snapshot)
    },
    setStreams(streams: Record<string, MediaStream>) {
      host?.setStreams(source.phase === 'session' ? streams : {})
    },
    notify(notification: MirrorNotification) {
      host?.sendNotification(notification)
    },
  }
}

export type MirrorAppOwner = ReturnType<typeof createMirrorAppOwner>
