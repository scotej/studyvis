import { useCallback, useEffect, useState } from 'react'

import { SettingsRow, SettingsSection } from '@/components/SettingsRow'
import { Button } from '@/components/ui/button'
import { Report } from '@/features/session'
import { listSessions, type SessionRecord } from '@/lib/db/sessions'

type LoadStatus = 'idle' | 'loading' | 'ready' | 'error'

export function SessionsCategory() {
  const [sessions, setSessions] = useState<SessionRecord[]>([])
  const [status, setStatus] = useState<LoadStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setStatus('loading')
    try {
      const rows = await listSessions()
      setSessions(rows)
      setStatus('ready')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setStatus('error')
    }
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot mount load: load awaits the Tauri command before any setState fires (same suppression as useIdentity.refresh).
    void load()
  }, [load])

  // Re-opened report uses the same Report shell that the fresh-session-end
  // mount in Home.tsx uses; the Close handler returns to this list rather
  // than firing sessionStore.reset (which has no state to clear here).
  if (selectedId) {
    return <Report sessionId={selectedId} onClose={() => setSelectedId(null)} />
  }

  return (
    <SettingsSection heading="Sessions">
      {status === 'loading' || status === 'idle' ? (
        <SessionRowSkeleton />
      ) : null}
      {status === 'error' ? (
        <SettingsRow
          label="Couldn't load session history"
          help={error ?? undefined}
          control={
            <Button variant="ghost" size="sm" onClick={() => void load()}>
              Retry
            </Button>
          }
        />
      ) : null}
      {status === 'ready' && sessions.length === 0 ? (
        <SettingsRow
          label="No sessions yet"
          help="Past sessions will appear here once you study with a friend."
        />
      ) : null}
      {status === 'ready' && sessions.length > 0
        ? sessions.map((session) => (
            <button
              key={session.id}
              type="button"
              className="text-left transition-colors outline-none hover:bg-bg-raised focus-visible:bg-bg-raised focus-visible:ring-3 focus-visible:ring-accent-ring"
              onClick={() => setSelectedId(session.id)}
            >
              <SettingsRow
                label={formatStartedAt(session.started_at)}
                help={formatSessionMeta(session)}
              />
            </button>
          ))
        : null}
    </SettingsSection>
  )
}

function formatStartedAt(ts: number | null): string {
  if (ts === null) return '—'
  const d = new Date(ts)
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function formatSessionMeta(session: SessionRecord): string {
  const minutes = session.total_minutes ?? 0
  const peers = decodePeers(session.peer_pubkeys).length
  const peerLabel =
    peers === 0 ? 'solo' : peers === 1 ? '1 friend' : `${peers} friends`
  const scoreLabel = session.score != null ? ` · ${session.score} / 100` : ''
  return `${minutes} min · ${peerLabel}${scoreLabel}`
}

function SessionRowSkeleton() {
  return (
    <div
      role="status"
      aria-label="Loading sessions"
      className="flex animate-pulse flex-col gap-2 py-3"
    >
      <div className="h-4 w-1/3 rounded-md bg-bg-raised" />
      <div className="h-3 w-1/4 rounded-md bg-bg-raised" />
    </div>
  )
}

function decodePeers(raw: string | null): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) {
      return parsed.filter((v): v is string => typeof v === 'string')
    }
  } catch {
    // Malformed JSON — treat as no peers, the report layer (V2) will repair.
  }
  return []
}
