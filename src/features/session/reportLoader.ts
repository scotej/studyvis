import { auditEventsListForSession } from '@/lib/db/audit'
import { listFriends, type Friend } from '@/lib/db/friends'
import {
  sessionTimelineGet,
  type SessionTimelineRecord,
} from '@/lib/db/sessionTimeline'
import { sessionsGet } from '@/lib/db/sessions'
import { logger } from '@/lib/log'
import { strings } from '@/strings'

import type { ResolvedReportData } from './reportSerialize'

const log = logger.child('report')

// Production report loader. The saved session, rather than the identity live
// in the UI, supplies the immutable local-owner key used by report analysis.
export async function loadReportData(
  sessionId: string
): Promise<ResolvedReportData> {
  const friendRowsPromise = listFriends().catch((err: unknown): Friend[] => {
    // Names enrich report rows but are never required to read local session
    // evidence. Keep the report available with peer-key fallbacks instead.
    log.warn('friends.list_failed', { cmd: 'friends_list', err })
    return []
  })
  // #236 — a missing or unreadable write-up is the same as not having one yet:
  // the report offers to write it from the raw journal instead of failing.
  const timelinePromise = sessionTimelineGet(sessionId).catch(
    (err: unknown): SessionTimelineRecord | null => {
      log.warn('timeline.get_failed', { cmd: 'session_timeline_get', err })
      return null
    }
  )
  const [session, auditEvents, friendRows, timeline] = await Promise.all([
    sessionsGet(sessionId),
    auditEventsListForSession(sessionId),
    friendRowsPromise,
    timelinePromise,
  ])
  if (!session) throw new Error(strings.report.notFound)

  const nameByEdPubkey = Object.fromEntries(
    friendRows
      .filter((f: Friend): f is Friend & { display_name: string } =>
        Boolean(f.display_name && f.display_name.trim().length > 0)
      )
      .map((f) => [f.ed_pubkey_hex, f.display_name])
  )
  const localDisplayName = session.local_display_name?.trim()
  if (session.local_ed_pubkey && localDisplayName) {
    nameByEdPubkey[session.local_ed_pubkey] = localDisplayName
  }
  return {
    session,
    auditEvents,
    timeline,
    nameByEdPubkey,
    // The saved session owns this value. Do not substitute the identity that
    // happens to be active when a historical report is opened.
    myEdPubkeyHex: session.local_ed_pubkey ?? null,
  }
}
