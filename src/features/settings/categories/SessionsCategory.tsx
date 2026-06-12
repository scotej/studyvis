import { useCallback, useEffect, useState } from 'react'
import { Trash2Icon } from 'lucide-react'
import { toast } from 'sonner'

import { SettingsRow, SettingsSection } from '@/components/SettingsRow'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'
import {
  listSessions,
  sessionsDelete,
  type SessionRecord,
} from '@/lib/db/sessions'
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
  const [pendingDelete, setPendingDelete] = useState<SessionRecord | null>(null)
  const [deleting, setDeleting] = useState(false)
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

  const confirmDelete = useCallback(async () => {
    if (!pendingDelete) return
    setDeleting(true)
    try {
      await sessionsDelete(pendingDelete.id)
      // Re-read from SQLite so stats/report (which also read SQLite) and this
      // list stay coherent after the row + its audit events are gone.
      await load()
      toast.success(copy.delete.deletedToast)
      setPendingDelete(null)
    } catch (err) {
      const message =
        err instanceof Error ? err.message : copy.delete.errorFallback
      toast.error(message)
    } finally {
      setDeleting(false)
    }
  }, [pendingDelete, load, copy.delete])

  return (
    <>
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
              <SettingsRow
                key={session.id}
                label={
                  <button
                    type="button"
                    className="-mx-2 -my-1 rounded-md px-2 py-1 text-left outline-none transition-colors hover:bg-bg-raised focus-visible:bg-bg-raised focus-visible:ring-3 focus-visible:ring-accent-ring"
                    onClick={() => onOpenSession(session.id)}
                  >
                    {formatStartedAt(session.started_at)}
                  </button>
                }
                help={formatSessionMeta(session)}
                control={
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setPendingDelete(session)}
                    aria-label={copy.delete.ariaLabel(
                      formatStartedAt(session.started_at)
                    )}
                  >
                    <Trash2Icon /> {copy.delete.cta}
                  </Button>
                }
              />
            ))
          : null}
      </SettingsSection>

      <Dialog
        open={Boolean(pendingDelete)}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{copy.delete.confirmTitle}</DialogTitle>
            <DialogDescription>{copy.delete.confirmBody}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setPendingDelete(null)}
              disabled={deleting}
            >
              {copy.delete.cancelCta}
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => void confirmDelete()}
              disabled={deleting}
              aria-disabled={deleting}
            >
              {copy.delete.confirmCta}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
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
