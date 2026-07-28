// The two human-readable summaries a friend row carries, extracted from
// FriendsListView so Settings → Friends renders the identical wording. Two
// surfaces describing the same friend with different words ("yesterday" here,
// "1 day ago" there) reads as two different facts.

import { strings } from '@/strings'

import type { FriendPresenceState } from './presence'

// Carries the full state in text, never color alone (DESIGN-SYSTEM §11):
// Available / Available · limited connection / Offline · seen … ago / Offline.
export function presenceLabel(
  presence: FriendPresenceState,
  now?: number
): string {
  const copy = strings.friends.list
  if (presence.state === 'online') {
    return presence.limited ? copy.availableLimited : copy.available
  }
  return formatOfflineSeen(presence.lastSeenAt, now)
}

// Session-scoped recency: the presence map only lives while the app runs, so
// anything beyond a day is indistinguishable from "before I opened the app" —
// show the plain label rather than a misleading large number.
function formatOfflineSeen(
  lastSeenAt: number | null,
  now: number | undefined
): string {
  const copy = strings.friends.list
  if (lastSeenAt === null) return copy.offline
  const reference = now ?? Date.now()
  const deltaMs = Math.max(0, reference - lastSeenAt)
  const minute = 60 * 1000
  const hour = 60 * minute
  const day = 24 * hour
  if (deltaMs >= day) return copy.offline
  if (deltaMs < 2 * minute) return copy.offlineSeen.justNow
  if (deltaMs < hour)
    return copy.offlineSeen.minutesAgo(Math.floor(deltaMs / minute))
  return copy.offlineSeen.hoursAgo(Math.floor(deltaMs / hour))
}

// Calendar-relative recency for "when did we last study together".
export function formatLastTogether(
  ts: number | null | undefined,
  now?: number
): string {
  const last = strings.friends.list.lastTogether
  if (!ts) return last.never
  const reference = now ?? Date.now()
  const deltaMs = Math.max(0, reference - ts)
  const day = 24 * 60 * 60 * 1000
  const days = Math.floor(deltaMs / day)
  if (days === 0) return last.today
  if (days === 1) return last.yesterday
  if (days < 7) return last.daysAgo(days)
  if (days < 30) {
    const weeks = Math.max(1, Math.floor(days / 7))
    return last.weeksAgo(weeks)
  }
  if (days < 365) {
    const months = Math.max(1, Math.floor(days / 30))
    return last.monthsAgo(months)
  }
  const years = Math.max(1, Math.floor(days / 365))
  return last.yearsAgo(years)
}
