import { useCallback, useEffect, useRef, useState } from 'react'

import { createMirrorHost } from './runtime'
import { registerMirrorReportHandoff } from './reportHandoff'
import type { MirrorConfig, MirrorNotification } from './wire'
import {
  parseMirrorControl,
  type MirrorControl,
  type MirrorSessionSnapshot,
} from './sessionBridge'

export type MirrorSessionOwner = {
  config: MirrorConfig | null
  starting: boolean
  connected: boolean
  takeover: boolean
  camera: MediaStream | null
  screen: MediaStream | null
  start: () => Promise<void>
  stop: () => Promise<void>
  publish: (snapshot: MirrorSessionSnapshot) => void
  setStreams: (streams: Record<string, MediaStream>) => void
  notify: (notification: MirrorNotification) => void
  attach: (
    sessionId: string,
    onControl: (
      control: MirrorControl
    ) => boolean | void | Promise<boolean | void>
  ) => () => void
}

export function useSessionMirror(
  sessionId: string | null,
  onControl: (
    control: MirrorControl
  ) => boolean | void | Promise<boolean | void>,
  applicationOwner?: MirrorSessionOwner
) {
  const attach = applicationOwner?.attach
  const externallyOwned = applicationOwner !== undefined
  const [config, setConfig] = useState<MirrorConfig | null>(null)
  const [starting, setStarting] = useState(false)
  const [connected, setConnected] = useState(false)
  const [takeover, setTakeover] = useState(false)
  const [camera, setCamera] = useState<MediaStream | null>(null)
  const [screen, setScreen] = useState<MediaStream | null>(null)
  const controlRef = useRef(onControl)
  useEffect(() => {
    controlRef.current = onControl
  }, [onControl])
  useEffect(() => {
    if (!attach || !sessionId) return
    return attach(sessionId, (control) => controlRef.current(control))
  }, [attach, sessionId])
  const hostRef = useRef<ReturnType<typeof createMirrorHost> | null>(null)
  const startGeneration = useRef(0)
  const snapshotRef = useRef<MirrorSessionSnapshot | null>(null)
  const unregisterReport = useRef<(() => void) | null>(null)

  const stop = useCallback(async () => {
    startGeneration.current += 1
    const host = hostRef.current
    hostRef.current = null
    unregisterReport.current?.()
    unregisterReport.current = null
    setConfig(null)
    setConnected(false)
    setCamera(null)
    setScreen(null)
    setTakeover(false)
    setStarting(false)
    controlRef.current({ type: 'ptt', active: false })
    await host?.stop()
  }, [])

  const start = useCallback(async () => {
    if (!sessionId || hostRef.current) return
    const generation = ++startGeneration.current
    setStarting(true)
    const host = createMirrorHost({
      onControl: (raw) => {
        const control = parseMirrorControl(raw)
        if (hostRef.current === host && control)
          return controlRef.current(control)
        return false
      },
      onCapture: (kind, stream) => {
        if (hostRef.current !== host) return
        if (kind === 'camera') setCamera(stream)
        else setScreen(stream)
      },
      onConnected: (next) => {
        if (hostRef.current !== host) return
        setConnected(next)
        if (next) setTakeover(true)
        else {
          controlRef.current({ type: 'ptt', active: false })
          controlRef.current({ type: 'screen_sharing', sharing: false })
        }
      },
    })
    hostRef.current = host
    try {
      const next = await host.start(sessionId)
      if (generation !== startGeneration.current || hostRef.current !== host) {
        await host.stop()
        return
      }
      setConfig(next)
      setTakeover(true)
      unregisterReport.current = registerMirrorReportHandoff(
        sessionId,
        host,
        next.generation
      )
      if (snapshotRef.current) host.publish(snapshotRef.current)
    } catch (error) {
      if (hostRef.current === host) hostRef.current = null
      await host.stop()
      throw error
    } finally {
      if (generation === startGeneration.current) setStarting(false)
    }
  }, [sessionId])

  useEffect(
    () => () => {
      startGeneration.current += 1
      const host = hostRef.current
      hostRef.current = null
      unregisterReport.current?.()
      unregisterReport.current = null
      void host?.stop()
    },
    [sessionId, externallyOwned]
  )

  const publish = useCallback((snapshot: MirrorSessionSnapshot) => {
    snapshotRef.current = snapshot
    hostRef.current?.publish(snapshot)
  }, [])
  const setStreams = useCallback((streams: Record<string, MediaStream>) => {
    hostRef.current?.setStreams(streams)
  }, [])
  const notify = useCallback((notification: MirrorNotification) => {
    hostRef.current?.sendNotification(notification)
  }, [])

  return (
    applicationOwner ?? {
      config,
      starting,
      connected,
      takeover,
      camera,
      screen,
      start,
      stop,
      publish,
      setStreams,
      notify,
    }
  )
}
