import { useCallback, useEffect, useState } from 'react'

import { SettingsRow, SettingsSection } from '@/components/SettingsRow'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { listSessions, type SessionRecord } from '@/lib/db/sessions'
import { strings } from '@/strings'

type LoadStatus = 'idle' | 'loading' | 'ready' | 'error'

export type SessionsCategoryProps = {
  // Settings owns the open-report state so the Report can replace the whole
  // settings shell (avoids a nested <main> landmark — see Settings.tsx).
  onOpenSession: (id: string) => void
}

export function SessionsCategory({ onOpenSession }: SessionsCategoryProps) {
  const [sessions, setSessions] = useState<SessionRecord[]>([])
  const [status, setStatus] = useState<LoadStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  const copy = strings.settings.sessions

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

  return (
    <SettingsSection heading={copy.heading}>
      {status === 'loading' || status === 'idle' ? (
        <SessionRowSkeleton />
      ) : null}
      {status === 'error' ? (
        <SettingsRow
          label={copy.loadErrorLabel}
          help={error ?? undefined}
          control={
            <Button variant="ghost" size="sm" onClick={() => void load()}>
              {strings.common.actions.retry}
            </Button>
          }
        />
      ) : null}
      {status === 'ready' && sessions.length === 0 ? (
        <SettingsRow label={copy.emptyLabel} help={copy.emptyHelp} />
      ) : null}
      {status === 'ready' && sessions.length > 0
        ? sessions.map((session) => (
            <button
              key={session.id}
              type="button"
              className="text-left transition-colors outline-none hover:bg-bg-raised focus-visible:bg-bg-raised focus-visible:ring-3 focus-visible:ring-accent-ring"
              onClick={() => onOpenSession(session.id)}
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
  if (ts === null) return strings.settings.sessions.missing
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
  const meta = strings.settings.sessions.meta
  const minutes = session.total_minutes ?? 0
  const peers = decodePeers(session.peer_pubkeys).length
  const peerLabel =
    peers === 0
      ? meta.solo
      : peers === 1
        ? meta.oneFriend
        : meta.manyFriends(peers)
  const scoreLabel =
    session.score != null ? ` · ${meta.score(session.score)}` : ''
  return `${meta.minutes(minutes)} · ${peerLabel}${scoreLabel}`
}

function SessionRowSkeleton() {
  return (
    <div
      role="status"
      aria-label={strings.settings.sessions.loadingAriaLabel}
      className="flex flex-col gap-2 py-3"
    >
      <Skeleton className="h-4 w-1/3" />
      <Skeleton className="h-3 w-1/4" />
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
