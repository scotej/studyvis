import { useCallback, useEffect, useState } from 'react'
import { ChevronLeftIcon } from 'lucide-react'

import { SettingsRow, SettingsSection } from '@/components/SettingsRow'
import { Button } from '@/components/ui/button'
import { listSessions, type SessionRecord } from '@/lib/db/sessions'

type LoadStatus = 'idle' | 'loading' | 'ready' | 'error'

export function SessionsCategory() {
  const [sessions, setSessions] = useState<SessionRecord[]>([])
  const [status, setStatus] = useState<LoadStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<SessionRecord | null>(null)

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

  if (selected) {
    return <SessionDetail session={selected} onBack={() => setSelected(null)} />
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
              onClick={() => setSelected(session)}
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

function SessionDetail({
  session,
  onBack,
}: {
  session: SessionRecord
  onBack: () => void
}) {
  const peers = decodePeers(session.peer_pubkeys)
  return (
    <SettingsSection
      heading={
        <span className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={onBack}
            aria-label="Back to sessions"
          >
            <ChevronLeftIcon /> Back
          </Button>
          Session detail
        </span>
      }
    >
      <SettingsRow label="Started" help={formatStartedAt(session.started_at)} />
      <SettingsRow label="Ended" help={formatStartedAt(session.ended_at)} />
      <SettingsRow
        label="Total minutes"
        help={`${session.total_minutes ?? 0}`}
      />
      <SettingsRow
        label="Participants"
        help={
          peers.length === 0
            ? 'No signed-hello bindings recorded for this session.'
            : peers.map((p) => `${p.slice(0, 12)}…`).join(', ')
        }
      />
      <SettingsRow
        label="Full report"
        help="Available in V2 — focused-time percentage and per-event audit log will appear here."
        disabled
      />
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
  return `${minutes} min · ${peerLabel}`
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
