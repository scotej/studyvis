// Settings → Friends: the roster, a per-friend detail panel (#101), and
// removal behind a confirm. The container owns everything the view cannot
// reach on its own — the friends store, the local identity the safety number
// is computed against, and the session history the study totals come from.

import { useCallback, useEffect, useMemo, useState } from 'react'
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
import { presenceState, type PresenceMap } from '@/features/friends'
import { useIdentity } from '@/features/identity'
// Deep path, not the '@/features/stats' barrel: the barrel statically
// re-exports Dashboard, which pulls recharts, and that would undo the lazy
// chunk StatsCategory deliberately splits it into.
import {
  NO_PARTNER_STUDY,
  partnerStudyTotals,
} from '@/features/stats/statsData'
import { pairFingerprint } from '@/lib/crypto/topics'
import type { Friend } from '@/lib/db/friends'
import { listSessions, type SessionRecord } from '@/lib/db/sessions'
import { logger } from '@/lib/log'
import { useFriendsStore } from '@/stores/friendsStore'
import { strings } from '@/strings'

import {
  FriendsCategoryView,
  type FriendDetail,
  type StudyHistoryStatus,
} from './FriendsCategoryView'

const log = logger.child('settings.friends')

export type FriendsCategoryProps = {
  // Live presence, threaded down from Home — the only owner of the
  // subscription. Absent in Storybook and in any host that has none, where the
  // panel drops its Status row rather than guessing "Offline".
  presence?: PresenceMap
}

export function FriendsCategory({ presence }: FriendsCategoryProps) {
  const friends = useFriendsStore((s) => s.friends)
  const remove = useFriendsStore((s) => s.remove)
  const { identity } = useIdentity()
  const [pendingRemoval, setPendingRemoval] = useState<Friend | null>(null)
  const [removing, setRemoving] = useState(false)
  const [sessions, setSessions] = useState<readonly SessionRecord[]>([])
  const [studyStatus, setStudyStatus] = useState<StudyHistoryStatus>('loading')
  const copy = strings.settings.friends

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const rows = await listSessions()
        if (cancelled) return
        setSessions(rows)
        setStudyStatus('ready')
      } catch (err) {
        // Tauri rejects with a plain string; the raw rusqlite chain belongs in
        // the log, not in a settings row. Only the two study lines degrade —
        // identity, keys and presence still render.
        log.error('list.failed', { cmd: 'sessions_list', err })
        if (!cancelled) setStudyStatus('error')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const totals = useMemo(
    () => partnerStudyTotals(sessions, friends),
    [sessions, friends]
  )
  const localEd = identity?.ed_pubkey_hex ?? null

  const details = useMemo<FriendDetail[]>(
    () =>
      friends.map((friend) => ({
        friend,
        presence: presence
          ? presenceState(presence, friend.ed_pubkey_hex)
          : null,
        safetyNumber: localEd ? safeFingerprint(localEd, friend) : null,
        study: totals.get(friend.ed_pubkey_hex) ?? NO_PARTNER_STUDY,
      })),
    [friends, presence, localEd, totals]
  )

  const confirmRemoval = useCallback(async () => {
    if (!pendingRemoval) return
    setRemoving(true)
    try {
      await remove(pendingRemoval.ed_pubkey_hex)
      toast.success(
        copy.removedToast(
          pendingRemoval.display_name?.trim() || copy.defaultFriendName
        )
      )
      setPendingRemoval(null)
    } catch (err) {
      const message =
        err instanceof Error ? err.message : copy.removeErrorFallback
      toast.error(message)
    } finally {
      setRemoving(false)
    }
  }, [pendingRemoval, remove, copy])

  return (
    <>
      <FriendsCategoryView
        details={details}
        studyStatus={studyStatus}
        onRemove={setPendingRemoval}
      />

      <Dialog
        open={Boolean(pendingRemoval)}
        onOpenChange={(open) => {
          if (!open) setPendingRemoval(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{copy.confirm.title}</DialogTitle>
            <DialogDescription>
              {pendingRemoval
                ? copy.confirm.body(
                    pendingRemoval.display_name?.trim() ||
                      copy.defaultFriendDisplay
                  )
                : ''}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setPendingRemoval(null)}
              disabled={removing}
            >
              {copy.confirm.cancelCta}
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => void confirmRemoval()}
              disabled={removing}
              aria-disabled={removing}
            >
              {copy.confirm.confirmCta}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

// pairFingerprint parses both keys as hex, so a friends row written by a
// future build (or a corrupt one) would otherwise take the whole pane down.
function safeFingerprint(localEd: string, friend: Friend): string | null {
  try {
    return pairFingerprint(localEd, friend.ed_pubkey_hex)
  } catch (err) {
    log.warn('safety_number.failed', { err })
    return null
  }
}
