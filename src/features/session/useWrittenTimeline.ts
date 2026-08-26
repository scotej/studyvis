// #236 — the report's side of the written session timeline: decide whether a
// session can be written up, run it once, and hand the result back.
//
// Both report surfaces mount the same component (the fresh post-session route
// and Settings → Sessions), so putting the decision here means a session that
// was interrupted mid-write-up — the app quit, the model was missing, AI was
// off at the time — gets another attempt the next time its report is opened.
// Nothing is persisted until a write-up succeeds, which is what makes that
// self-healing rather than a state machine to maintain.

import { useCallback, useEffect, useRef, useState } from 'react'

import { useModelStore } from '@/features/ai/modelStore'
import type { SessionTimelineRecord } from '@/lib/db/sessionTimeline'
import { logger } from '@/lib/log'
import { useSessionStore } from '@/stores/sessionStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { strings } from '@/strings'

import { readObservations } from './sessionJournal'
import {
  generateSessionTimeline,
  SessionTimelineError,
  type SessionTimeline,
} from './sessionTimeline'

const log = logger.child('session.timeline.ui')

// Storybook renders the report shell outside Tauri, where the journal probe
// would reject and paint a failure banner over a fixture that has no journal at
// all. Same runtime probe `sampleLoop`'s `enumerateDisplayCount` uses.
function hasTauriRuntime(): boolean {
  if (typeof window === 'undefined') return false
  return '__TAURI_INTERNALS__' in window || '__TAURI__' in window
}

export type WrittenTimelineStatus =
  // Nothing pending: the report renders the stored write-up, or the
  // nothing-was-recorded copy when there is none.
  | { kind: 'idle' }
  | { kind: 'generating' }
  // Observations exist but cannot be written up right now — AI is off, or a
  // session is running and owns the model. Not an error; no retry offered.
  | { kind: 'blocked'; message: string }
  | { kind: 'failed'; message: string }

// One write-up per session at a time, shared across mounts. React 19 Strict
// Mode runs effects twice and the two report surfaces can mount in sequence;
// without this, one session could start two model passes that both then write
// the same row.
const inFlight = new Map<string, Promise<SessionTimeline | null>>()

function runOnce(
  sessionId: string,
  modelId: string,
  declaredTopic: string | null
): Promise<SessionTimeline | null> {
  const existing = inFlight.get(sessionId)
  if (existing) return existing
  const attempt = generateSessionTimeline({
    sessionId,
    modelId,
    declaredTopic,
  }).finally(() => {
    inFlight.delete(sessionId)
  })
  inFlight.set(sessionId, attempt)
  return attempt
}

function toRecord(
  sessionId: string,
  timeline: SessionTimeline
): SessionTimelineRecord {
  return {
    session_id: sessionId,
    generated_at: timeline.generatedAt,
    model_id: timeline.modelId,
    source: timeline.source,
    entries: JSON.stringify(timeline.entries),
    truncated: timeline.truncated ? 1 : 0,
  }
}

export type UseWrittenTimelineArgs = {
  sessionId: string
  // False while the report is still loading; the write-up waits for the row so
  // it can skip a session that already has one.
  ready: boolean
  timeline: SessionTimelineRecord | null
  declaredTopic: string | null
  // Called once with a fresh write-up so the report can render and export it.
  onWritten: (record: SessionTimelineRecord) => void
}

export function useWrittenTimeline({
  sessionId,
  ready,
  timeline,
  declaredTopic,
  onWritten,
}: UseWrittenTimelineArgs): {
  status: WrittenTimelineStatus
  rewrite: () => void
} {
  const [status, setStatus] = useState<WrittenTimelineStatus>({ kind: 'idle' })
  const [attempt, setAttempt] = useState(0)
  // A stored write-up is never replaced on its own — only the explicit rewrite
  // action asks for a second pass.
  const requested = useRef<string | null>(null)
  const onWrittenRef = useRef(onWritten)
  useEffect(() => {
    onWrittenRef.current = onWritten
  }, [onWritten])

  useEffect(() => {
    if (!ready) return
    if (timeline && attempt === 0) return
    const key = `${sessionId}:${attempt}`
    if (requested.current === key) return
    requested.current = key

    let cancelled = false
    const run = async () => {
      if (!hasTauriRuntime()) return
      const settings = useSettingsStore.getState().values
      // A session that recorded nothing has nothing to write up, and saying so
      // is different from saying the model failed. Reading the journal first is
      // what lets the two be told apart.
      let hasObservations: boolean
      try {
        const journal = await readObservations(sessionId)
        hasObservations = journal.observations.length > 0
      } catch (err) {
        log.warn('journal.probe_failed', { err })
        if (!cancelled) {
          setStatus({
            kind: 'failed',
            message: strings.report.sections.written.failed,
          })
        }
        return
      }
      if (cancelled) return
      if (!hasObservations) {
        setStatus({ kind: 'idle' })
        return
      }

      const copy = strings.report.sections.written
      if (useSessionStore.getState().status === 'active') {
        setStatus({ kind: 'blocked', message: copy.sessionActive })
        return
      }
      const modelId = useModelStore.getState().activeModelId
      if (!settings.aiFeaturesEnabled || !modelId) {
        setStatus({ kind: 'blocked', message: copy.aiOff })
        return
      }

      setStatus({ kind: 'generating' })
      try {
        const written = await runOnce(sessionId, modelId, declaredTopic)
        if (cancelled) return
        if (!written) {
          setStatus({ kind: 'idle' })
          return
        }
        onWrittenRef.current(toRecord(sessionId, written))
        setStatus({ kind: 'idle' })
      } catch (err) {
        log.warn('write_up.failed', { err })
        if (cancelled) return
        setStatus(
          err instanceof SessionTimelineError && err.code === 'session_active'
            ? { kind: 'blocked', message: copy.sessionActive }
            : { kind: 'failed', message: copy.failed }
        )
      }
    }

    void run()
    return () => {
      // Only the state update is cancelled. An in-flight write-up keeps running
      // and still persists: the post-session report is usually closed within
      // seconds, and abandoning the pass there would mean it never completes.
      cancelled = true
      // Release the once-only latch as well. React 19 Strict Mode tears the
      // first effect down while the journal probe above is still awaiting, so
      // without this the remount finds the latch already claimed by a run that
      // returned early — and the write-up never happens in dev at all. The
      // `inFlight` map still keeps the expensive pass itself to one.
      if (requested.current === key) requested.current = null
    }
  }, [sessionId, ready, timeline, attempt, declaredTopic])

  const rewrite = useCallback(() => setAttempt((n) => n + 1), [])

  return { status, rewrite }
}
