import { useCallback, useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { toast } from 'sonner'

import { logger } from '@/lib/log'
import { strings } from '@/strings'

import { createMirrorHost, type MirrorDiagnostic } from './runtime'
import { registerMirrorReportHandoff } from './reportHandoff'
import type { MirrorConfig, MirrorNotification } from './wire'
import {
  parseMirrorControl,
  type MirrorControl,
  type MirrorSessionSnapshot,
} from './sessionBridge'

const log = logger.child('mirror.host')

export function useSessionMirror(
  sessionId: string | null,
  onControl: (
    control: MirrorControl
  ) => boolean | void | Promise<boolean | void>
) {
  const [config, setConfig] = useState<MirrorConfig | null>(null)
  const [starting, setStarting] = useState(false)
  const [connected, setConnected] = useState(false)
  const [takeover, setTakeover] = useState(false)
  const [camera, setCamera] = useState<MediaStream | null>(null)
  const [screen, setScreen] = useState<MediaStream | null>(null)
  const [diagnostic, setDiagnostic] = useState<MirrorDiagnostic | null>(null)
  const controlRef = useRef(onControl)
  useEffect(() => {
    controlRef.current = onControl
  }, [onControl])
  const connectedRef = useRef(false)
  const announceResumeRef = useRef(false)
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
    connectedRef.current = false
    announceResumeRef.current = false
    setConnected(false)
    setCamera(null)
    setScreen(null)
    setDiagnostic(null)
    setTakeover(false)
    setStarting(false)
    controlRef.current({ type: 'ptt', active: false })
    controlRef.current({ type: 'microphone', muted: true })
    await host?.stop()
  }, [])

  const start = useCallback(
    async (resume = false) => {
      if (!sessionId || hostRef.current) return
      const generation = ++startGeneration.current
      announceResumeRef.current = resume
      setStarting(true)
      setDiagnostic(null)
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
        onDiagnostic: (next) => {
          // While a browser is connected a diagnostic is another device's, and
          // must not later read as the cause of an unrelated drop.
          if (hostRef.current === host && !connectedRef.current)
            setDiagnostic(next)
        },
        onConnected: (next) => {
          if (hostRef.current !== host) return
          connectedRef.current = next
          setConnected(next)
          if (next) {
            setTakeover(true)
            setDiagnostic(null)
            if (announceResumeRef.current) {
              announceResumeRef.current = false
              toast.success(strings.mirror.companionResumed)
            }
          } else {
            controlRef.current({ type: 'ptt', active: false })
            controlRef.current({ type: 'microphone', muted: true })
            controlRef.current({ type: 'screen_sharing', sharing: false })
          }
        },
      })
      hostRef.current = host
      try {
        const next = await host.start(sessionId, resume)
        if (
          generation !== startGeneration.current ||
          hostRef.current !== host
        ) {
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
    },
    [sessionId]
  )

  useEffect(
    () => () => {
      startGeneration.current += 1
      const host = hostRef.current
      hostRef.current = null
      unregisterReport.current?.()
      unregisterReport.current = null
      controlRef.current({ type: 'ptt', active: false })
      controlRef.current({ type: 'microphone', muted: true })
      void host?.stop()
    },
    [sessionId]
  )

  // #515 — a reloaded desktop page leaves its companion server running in the
  // native process. Rejoining that session adopts it, so the paired browser
  // reconnects without a new password.
  useEffect(() => {
    if (!sessionId) return
    let cancelled = false
    void invoke<boolean>('mirror_resumable', { sessionId })
      .then(async (resumable) => {
        if (cancelled || !resumable || hostRef.current) return
        await start(true)
      })
      .catch((err: unknown) => {
        if (!cancelled) log.warn('resume.failed', { err })
      })
    return () => {
      cancelled = true
    }
  }, [sessionId, start])

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
    diagnostic,
    start,
    stop,
    publish,
    setStreams,
    notify,
  }
}
