// Settings → Sessions container: reads local SQLite history and owns the
// destructive delete confirmation. The presentational list lives beside it so
// Storybook can exercise populated history without a Tauri runtime.

import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  listSessions,
  sessionsDelete,
  type SessionRecord,
} from '@/lib/db/sessions'
import { logger } from '@/lib/log'

const log = logger.child('settings.sessions')

import { strings } from '@/strings'

import {
  SessionsCategoryView,
  type SessionHistoryStatus,
} from './SessionsCategoryView'

export type SessionsCategoryProps = {
  // Settings owns the open-report state so the Report can replace the whole
  // settings shell (avoids a nested <main> landmark — see Settings.tsx).
  onOpenSession: (id: string) => void
  focusSessionId?: string | null
  onFocusRestored?: () => void
}

export function SessionsCategory({
  onOpenSession,
  focusSessionId,
  onFocusRestored,
}: SessionsCategoryProps) {
  const [sessions, setSessions] = useState<SessionRecord[]>([])
  const [status, setStatus] = useState<SessionHistoryStatus>('loading')
  const [error, setError] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<SessionRecord | null>(null)
  const [deleting, setDeleting] = useState(false)
  const latestLoadRequest = useRef(0)
  const deleteOpenerRef = useRef<HTMLButtonElement | null>(null)
  const deleteSucceededRef = useRef(false)
  const sessionsHeadingRef = useRef<HTMLHeadingElement | null>(null)
  const copy = strings.settings.sessions

  const load = useCallback(async () => {
    const request = ++latestLoadRequest.current
    setStatus('loading')
    setError(null)
    try {
      const rows = await listSessions()
      if (request !== latestLoadRequest.current) return
      setSessions(rows)
      setStatus('ready')
    } catch (err) {
      if (request !== latestLoadRequest.current) return
      // Tauri rejects with a plain string, so the raw backend text (a
      // rusqlite error chain) used to land verbatim in the row's help line.
      // Keep it in the log for debugging; the user gets friendly copy.
      log.error('list.failed', { cmd: 'sessions_list', err })
      setError(copy.loadErrorHelp)
      setStatus('error')
    }
  }, [copy.loadErrorHelp])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot mount load: load awaits the Tauri command before any setState fires (same suppression as useIdentity.refresh).
    void load()
  }, [load])

  const confirmDelete = useCallback(async () => {
    if (!pendingDelete || deleting) return
    const sessionToDelete = pendingDelete
    setDeleting(true)
    try {
      await sessionsDelete(sessionToDelete.id)
      // Re-read from SQLite so stats/report (which also read SQLite) and this
      // list stay coherent after the row + its audit events are gone.
      await load()
      toast.success(copy.delete.deletedToast)
      deleteSucceededRef.current = true
      // Keep a different selection intact if something else opened it while
      // this operation was pending. The dialog is also interaction-locked
      // below, but the ID guard makes the async completion independently safe.
      setPendingDelete((current) =>
        current?.id === sessionToDelete.id ? null : current
      )
    } catch (err) {
      const message =
        err instanceof Error ? err.message : copy.delete.errorFallback
      toast.error(message)
    } finally {
      setDeleting(false)
    }
  }, [pendingDelete, deleting, load, copy.delete])

  const restoreDeleteDialogFocus = useCallback((event: Event) => {
    // There is no DialogTrigger: opening is driven by a per-row action. Stop
    // Radix from falling back to body and return focus to a live, meaningful
    // target instead.
    event.preventDefault()
    if (deleteSucceededRef.current) {
      sessionsHeadingRef.current?.focus()
    } else {
      deleteOpenerRef.current?.focus()
    }
    deleteSucceededRef.current = false
    deleteOpenerRef.current = null
  }, [])

  const setSessionsHeadingRef = useCallback(
    (heading: HTMLHeadingElement | null) => {
      sessionsHeadingRef.current = heading
    },
    []
  )

  return (
    <>
      <SessionsCategoryView
        sessions={sessions}
        status={status}
        error={error}
        onRetry={() => void load()}
        onOpenSession={onOpenSession}
        onDelete={(session, opener) => {
          if (!deleting) {
            deleteSucceededRef.current = false
            deleteOpenerRef.current = opener
            setPendingDelete(session)
          }
        }}
        focusSessionId={focusSessionId}
        onFocusRestored={onFocusRestored}
        onHeadingRef={setSessionsHeadingRef}
      />

      <Dialog
        open={Boolean(pendingDelete)}
        onOpenChange={(open) => {
          if (!open && !deleting) setPendingDelete(null)
        }}
      >
        <DialogContent
          showCloseButton={false}
          onEscapeKeyDown={(event) => {
            if (deleting) event.preventDefault()
          }}
          onPointerDownOutside={(event) => {
            if (deleting) event.preventDefault()
          }}
          onInteractOutside={(event) => {
            if (deleting) event.preventDefault()
          }}
          onCloseAutoFocus={restoreDeleteDialogFocus}
        >
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
