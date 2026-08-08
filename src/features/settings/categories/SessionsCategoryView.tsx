// Presentational half of Settings → Sessions. Keeping the SQLite container
// separate lets Storybook cover the populated history, including its explicit
// per-session report action, without needing a desktop runtime.

import { useCallback, useEffect, useRef } from 'react'
import { FileTextIcon, Trash2Icon } from 'lucide-react'

import {
  SettingsRow,
  SettingsSection,
  settingsRowChrome,
} from '@/components/SettingsRow'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import type { SessionRecord } from '@/lib/db/sessions'
import { cn } from '@/lib/utils'
import { strings } from '@/strings'

export type SessionHistoryStatus = 'loading' | 'ready' | 'error'

export type SessionsCategoryViewProps = {
  sessions: readonly SessionRecord[]
  status: SessionHistoryStatus
  error?: string | null
  onRetry: () => void
  onOpenSession: (id: string) => void
  onDelete: (session: SessionRecord, opener: HTMLButtonElement) => void
  // Settings retains this ID while a historical report is open. When its
  // Back action remounts this list, focus returns to the originating action.
  focusSessionId?: string | null
  onFocusRestored?: () => void
  // The stateful container owns dialog-close focus restoration, so it needs
  // the same heading fallback the historical-report route uses.
  onHeadingRef?: (heading: HTMLHeadingElement | null) => void
}

export function SessionsCategoryView({
  sessions,
  status,
  error,
  onRetry,
  onOpenSession,
  onDelete,
  focusSessionId,
  onFocusRestored,
  onHeadingRef,
}: SessionsCategoryViewProps) {
  const copy = strings.settings.sessions
  const reportButtonRefs = useRef(new Map<string, HTMLButtonElement>())
  const headingRef = useRef<HTMLHeadingElement>(null)
  const setHeadingRef = useCallback(
    (heading: HTMLHeadingElement | null) => {
      headingRef.current = heading
      onHeadingRef?.(heading)
    },
    [onHeadingRef]
  )

  useEffect(() => {
    if (!focusSessionId) return

    const sourceButton = reportButtonRefs.current.get(focusSessionId)
    if (status === 'ready' && sourceButton) {
      sourceButton.focus()
      onFocusRestored?.()
      return
    }

    // The session query may still be loading after Report unmounts. Give the
    // new screen an immediate, announced focus target; if the source row
    // arrives, the next render restores the more specific action. A missing
    // or deleted row keeps this safe heading fallback.
    headingRef.current?.focus()
    if (status !== 'loading') onFocusRestored?.()
  }, [focusSessionId, onFocusRestored, sessions, status])

  return (
    <SettingsSection heading={copy.heading} headingRef={setHeadingRef}>
      {status === 'loading' ? <SessionListSkeleton /> : null}
      {status === 'error' ? (
        <SettingsRow
          label={copy.loadErrorLabel}
          help={error ?? copy.loadErrorHelp}
          control={
            <Button variant="ghost" size="sm" onClick={onRetry}>
              {strings.common.actions.retry}
            </Button>
          }
        />
      ) : null}
      {status === 'ready' && sessions.length === 0 ? (
        <SettingsRow label={copy.emptyLabel} help={copy.emptyHelp} />
      ) : null}
      {status === 'ready'
        ? sessions.map((session, index) => {
            const startedAt = formatStartedAt(session.started_at)
            const ordinal = index + 1
            return (
              <SettingsRow
                key={session.id}
                label={startedAt}
                help={formatSessionMeta(session)}
                control={
                  <div className="flex items-center gap-1">
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={() => onOpenSession(session.id)}
                      aria-label={copy.review.ariaLabel(ordinal, startedAt)}
                      ref={(button) => {
                        if (button) {
                          reportButtonRefs.current.set(session.id, button)
                        } else {
                          reportButtonRefs.current.delete(session.id)
                        }
                      }}
                    >
                      <FileTextIcon /> {copy.review.cta}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={(event) =>
                        onDelete(session, event.currentTarget)
                      }
                      aria-label={copy.delete.ariaLabel(ordinal, startedAt)}
                    >
                      <Trash2Icon /> {copy.delete.cta}
                    </Button>
                  </div>
                }
              />
            )
          })
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
  const parts: string[] = []

  if (session.total_minutes !== null) {
    parts.push(meta.minutes(session.total_minutes))
  }

  const peers = decodePeers(session.peer_pubkeys)
  if (peers !== null) {
    parts.push(
      peers.length === 0
        ? meta.solo
        : peers.length === 1
          ? meta.oneFriend
          : meta.manyFriends(peers.length)
    )
  }
  // I83 — a scored session shows its score; a session that recorded AI as ON
  // and still has no score says so. A row with ai_enabled 0 or NULL adds
  // nothing, because "AI was off" and "we never recorded it" are not claims
  // this list should invent.
  const scoreLabel =
    session.score != null
      ? meta.score(session.score)
      : session.ai_enabled === 1
        ? meta.notMeasured
        : null
  if (scoreLabel) parts.push(scoreLabel)

  return parts.length > 0 ? parts.join(' · ') : meta.unknown
}

// Mirrors a ready SettingsRow's silhouette (py-4 + gap-1 label column,
// border-b, an h-8 bar where the action buttons sit) so resolving from
// loading to ready swaps content without a jump or a border pop-in.
function SessionRowSkeleton() {
  return (
    <div
      className={cn(
        'flex items-center justify-between gap-6',
        settingsRowChrome
      )}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="h-3 w-1/4" />
      </div>
      <Skeleton className="h-8 w-48 shrink-0" />
    </div>
  )
}

function SessionListSkeleton() {
  return (
    <div role="status" aria-label={strings.settings.sessions.loadingAriaLabel}>
      <SessionRowSkeleton />
      <SessionRowSkeleton />
      <SessionRowSkeleton />
    </div>
  )
}

function decodePeers(raw: string | null): string[] | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) {
      return parsed.filter((v): v is string => typeof v === 'string')
    }
  } catch {
    // Malformed JSON is not evidence of a solo session. The report layer (V2)
    // will attempt its own recovery; history keeps the list metadata honest.
  }
  return null
}
