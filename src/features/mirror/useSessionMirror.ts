import { useCallback, useEffect, useRef, useState } from 'react'

import { createMirrorHost } from './runtime'
import { registerMirrorReportHandoff } from './reportHandoff'
import type { MirrorConfig, MirrorNotification } from './wire'
import {
  parseMirrorControl,
  type MirrorControl,
  type MirrorSessionSnapshot,
} from './sessionBridge'

export function useSessionMirror(
  sessionId: string | null,
  onControl: (control: MirrorControl) => void
) {
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
        if (hostRef.current === host && control) controlRef.current(control)
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
        else controlRef.current({ type: 'ptt', active: false })
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
    [sessionId]
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

  return {
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
}
