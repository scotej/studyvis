// V3-P1 — Pure data transforms for the local stats dashboard.
//
// Same seam as features/session/reportData.ts: every computation is pure,
// React-free, and Tauri-free, so unit tests pin the numbers without a DOM
// and Dashboard.tsx only owns the data-fetching shell + rendering.
//
// Sources: the local `sessions` table (sessions_list) + the local
// `friends` table (friends_list). audit_events is a *permitted* stats
// source per ARCHITECTURE.md §9, not an obligation — every figure the
// four stats need already lives on the sessions row (started_at,
// total_minutes, score, peer_pubkeys), so it is not queried. Nothing
// here transmits anywhere; it only reshapes rows already on the device.

import type { Friend } from '@/lib/db/friends'
import type { SessionRecord } from '@/lib/db/sessions'
import { decodePeerPresenceMsForPeers } from '@/lib/db/sessionPresence'

export const STREAK_MIN_MINUTES = 25
export const FOCUS_WINDOW_DAYS = 30
export const TOP_PARTNERS_LIMIT = 5
// Shared by the Study-minutes bar chart (Dashboard) and the Focus-over-time
// line chart (FocusInsights): they stack in the same column, so a differing
// YAxis width would misalign their left plot edges by that difference.
export const CHART_Y_AXIS_WIDTH = 36

// R2 — "Study minutes" for a session = the minutes the user spent in the
// study session. Deliberately raw presence time (total_minutes), NOT
// total_minutes * focused_pct: this is a distinct concept from the report's
// AI-derived "Focused-time %", and reserving "Focused" for the AI concept
// keeps the two adjacent surfaces from colliding on the same word.
// focused_pct is null for V1 / AI-off sessions, the streak rule already
// counts raw session minutes, and the body-doubling premise treats presence
// time as study time. Isolated as one helper so a later phase can switch to
// an AI-weighted definition without touching the rest of this module.
export function studyMinutesForSession(session: SessionRecord): number {
  return session.total_minutes ?? 0
}

function logicalStudyDurationMs(session: SessionRecord): number | null {
  const duration = session.total_duration_ms
  // NULL means this is a pre-007 row: use its precise map unchanged. A
  // present-but-invalid/stale durable value instead falls back to the legacy
  // minute/presence lower bounds, exactly as session re-entry does.
  if (duration === null || duration === undefined) return null
  const minuteCount =
    typeof session.total_minutes === 'number' &&
    Number.isSafeInteger(session.total_minutes) &&
    session.total_minutes >= 0
      ? session.total_minutes
      : null
  // A valid 007 total is the authoritative local awake duration. A malformed
  // old/new write may fall back to peer timing, but a partner must never make
  // a known exact session longer merely by claiming excess overlap.
  const exact =
    typeof duration === 'number' &&
    Number.isSafeInteger(duration) &&
    duration >= 0 &&
    minuteCount !== null &&
    Math.floor(duration / 60_000) === minuteCount
      ? duration
      : null
  return exact
}

// Local calendar day key, YYYY-MM-DD. `timeZone` defaults to the runtime
// local zone (what a local-first user expects); tests pass an explicit
// zone for determinism. en-CA formats as ISO-like YYYY-MM-DD, which sorts
// lexicographically.
export function dayKey(ts: number, timeZone?: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(ts))
}

// Calendar arithmetic on a YYYY-MM-DD key. Uses a UTC anchor purely as a
// date counter — the key already encoded the user's local day, so this
// never re-applies a wall-clock offset and is DST-immune.
export function addDays(key: string, delta: number): string {
  const [y, m, d] = key.split('-').map(Number)
  const cur = new Date(Date.UTC(y, m - 1, d))
  cur.setUTCDate(cur.getUTCDate() + delta)
  const yy = cur.getUTCFullYear()
  const mm = String(cur.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(cur.getUTCDate()).padStart(2, '0')
  return `${yy}-${mm}-${dd}`
}

function enumerateDays(endKey: string, count: number): string[] {
  const out: string[] = []
  for (let i = count - 1; i >= 0; i--) out.push(addDays(endKey, -i))
  return out
}

// Day of the week a YYYY-MM-DD key falls on, 0 = Sunday. Same UTC-anchor
// trick as addDays: the key is already a local calendar day, so this counts
// days rather than re-applying an offset.
export function weekdayIndex(key: string): number {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay()
}

// Compact, locale-free axis label derived straight from the key so the
// chart and the tests agree on the exact string.
function shortDayLabel(key: string): string {
  const [, m, d] = key.split('-').map(Number)
  return `${m}/${d}`
}

// Study minutes summed per local calendar day, over all of history. Shared
// by the trailing-30-day bar chart and the year heatmap so the two surfaces
// can never disagree about what a day is worth.
function minutesByDay(
  sessions: readonly SessionRecord[],
  timeZone?: string
): Map<string, number> {
  const totals = new Map<string, number>()
  for (const s of sessions) {
    if (s.started_at == null) continue
    const key = dayKey(s.started_at, timeZone)
    totals.set(key, (totals.get(key) ?? 0) + studyMinutesForSession(s))
  }
  return totals
}

// Local calendar days carrying at least one session of >= STREAK_MIN_MINUTES —
// the day set both streak calculations walk.
function streakQualifyingDays(
  sessions: readonly SessionRecord[],
  timeZone?: string
): Set<string> {
  const qualifying = new Set<string>()
  for (const s of sessions) {
    if (s.started_at == null) continue
    if ((s.total_minutes ?? 0) >= STREAK_MIN_MINUTES) {
      qualifying.add(dayKey(s.started_at, timeZone))
    }
  }
  return qualifying
}

export type DailyFocus = { day: string; label: string; minutes: number }

// Study minutes bucketed into the trailing FOCUS_WINDOW_DAYS calendar
// days ending on `now`'s local day, inclusive. Always returns exactly
// FOCUS_WINDOW_DAYS entries in chronological order; days with no sessions
// are zero-filled so the bar chart has a continuous x-axis.
export function studyMinutesPerDay(
  sessions: readonly SessionRecord[],
  now: number,
  timeZone?: string
): DailyFocus[] {
  const totals = minutesByDay(sessions, timeZone)
  return enumerateDays(dayKey(now, timeZone), FOCUS_WINDOW_DAYS).map((day) => ({
    day,
    label: shortDayLabel(day),
    minutes: totals.get(day) ?? 0,
  }))
}

// Current study streak: consecutive calendar days, each with at least one
// session of >= STREAK_MIN_MINUTES, counting back from the most recent
// qualifying day. A one-day grace lets the run start at today OR
// yesterday so opening the app before today's session doesn't read 0 on a
// live streak; if the latest qualifying day is older than yesterday the
// streak is broken (0).
export function computeStreak(
  sessions: readonly SessionRecord[],
  now: number,
  timeZone?: string
): number {
  const qualifying = streakQualifyingDays(sessions, timeZone)
  if (qualifying.size === 0) return 0

  const today = dayKey(now, timeZone)
  const yesterday = addDays(today, -1)
  let cursor: string
  if (qualifying.has(today)) cursor = today
  else if (qualifying.has(yesterday)) cursor = yesterday
  else return 0

  let streak = 0
  while (qualifying.has(cursor)) {
    streak += 1
    cursor = addDays(cursor, -1)
  }
  return streak
}

// #99 — Longest run of consecutive qualifying days anywhere in history, not
// just the run that is live today. Walks the sorted day set and only counts a
// day as a run start when the previous day is absent, so each run is measured
// once. Same >= STREAK_MIN_MINUTES rule as the current streak: two numbers
// that mean the same thing must be earned the same way.
export function computeLongestStreak(
  sessions: readonly SessionRecord[],
  timeZone?: string
): number {
  const qualifying = streakQualifyingDays(sessions, timeZone)
  let longest = 0
  for (const day of qualifying) {
    if (qualifying.has(addDays(day, -1))) continue
    let run = 0
    let cursor = day
    while (qualifying.has(cursor)) {
      run += 1
      cursor = addDays(cursor, 1)
    }
    if (run > longest) longest = run
  }
  return longest
}

// #99 — the year-at-a-glance study heatmap (the Anki/GitHub contribution
// grid). 53 week columns × 7 day rows, the last column being the current,
// partial week; the window therefore always covers at least a full year
// (365 + weekday-index days) and the grid starts on a Sunday.
export const HEATMAP_WEEKS = 53

// Lower minute bounds for levels 1–4; anything below the first is level 0.
// Fixed rather than relative to the user's own maximum: a scale that
// re-normalises every time a single long session lands would make yesterday's
// colour mean something different today, and these thresholds (a token
// pomodoro, half an hour, an hour, two hours) read the same to everyone.
export const HEATMAP_LEVEL_MINUTES: readonly number[] = [1, 30, 60, 120]

export type HeatmapLevel = 0 | 1 | 2 | 3 | 4

export function heatmapLevel(minutes: number): HeatmapLevel {
  let level = 0
  for (const threshold of HEATMAP_LEVEL_MINUTES) {
    if (minutes >= threshold) level += 1
  }
  return level as HeatmapLevel
}

export type HeatmapDay = {
  day: string
  minutes: number
  level: HeatmapLevel
}

// Which column a month's name is drawn above. One entry per month whose first
// day of the grid falls in a different month than the column before it.
export type HeatmapMonth = { weekIndex: number; label: string }

export type StudyHeatmap = {
  // Column-major: weeks[w][d] is the (w+1)th week's day d, 0 = Sunday. Cells
  // after today are null — the current week is partial, and drawing empty
  // squares for days that haven't happened reads as "you studied nothing".
  weeks: (HeatmapDay | null)[][]
  months: HeatmapMonth[]
  daysInWindow: number
  daysStudied: number
  totalMinutes: number
  // All-time, deliberately: the grid already shows the last year, and a
  // personal best that silently expires is worse than no personal best.
  longestStreak: number
  busiest: HeatmapDay | null
}

// `locale` joins `timeZone` as an injectable so the month labels are
// deterministic under test; production passes neither and gets the runtime's
// own locale + zone, which is what a local-first user expects.
function monthLabel(key: string, locale?: string): string {
  const [y, m, d] = key.split('-').map(Number)
  return new Intl.DateTimeFormat(locale, {
    timeZone: 'UTC',
    month: 'short',
  }).format(new Date(Date.UTC(y, m - 1, d)))
}

export function buildStudyHeatmap(
  sessions: readonly SessionRecord[],
  now: number,
  timeZone?: string,
  locale?: string
): StudyHeatmap {
  const totals = minutesByDay(sessions, timeZone)
  const today = dayKey(now, timeZone)
  const start = addDays(today, -((HEATMAP_WEEKS - 1) * 7 + weekdayIndex(today)))

  const weeks: (HeatmapDay | null)[][] = []
  const months: HeatmapMonth[] = []
  let daysInWindow = 0
  let daysStudied = 0
  let totalMinutes = 0
  let busiest: HeatmapDay | null = null
  let lastMonth = ''

  for (let w = 0; w < HEATMAP_WEEKS; w++) {
    const column: (HeatmapDay | null)[] = []
    for (let d = 0; d < 7; d++) {
      const day = addDays(start, w * 7 + d)
      if (day > today) {
        column.push(null)
        continue
      }
      const minutes = totals.get(day) ?? 0
      const cell: HeatmapDay = { day, minutes, level: heatmapLevel(minutes) }
      column.push(cell)
      daysInWindow += 1
      totalMinutes += minutes
      if (minutes > 0) daysStudied += 1
      if (minutes > (busiest?.minutes ?? 0)) busiest = cell
    }
    weeks.push(column)
    // Label a column when its first day opens a month the previous column
    // didn't already cover. Keyed off the column's Sunday, so a month that
    // starts mid-week is labelled above the week it starts in.
    const first = column[0]
    if (first && first.day.slice(0, 7) !== lastMonth) {
      lastMonth = first.day.slice(0, 7)
      months.push({ weekIndex: w, label: monthLabel(first.day, locale) })
    }
  }

  return {
    weeks,
    months,
    daysInWindow,
    daysStudied,
    totalMinutes,
    longestStreak: computeLongestStreak(sessions, timeZone),
    busiest,
  }
}

export type StudyPartner = {
  edPubkeyHex: string
  name: string
  sessions: number
}

function parsePeerPubkeys(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (Array.isArray(parsed)) {
      return Array.from(
        new Set(parsed.filter((v): v is string => typeof v === 'string'))
      )
    }
  } catch {
    // Malformed JSON — treat as no peers, same tolerance as the V2 report
    // layer (reportData / SessionsCategory).
  }
  return []
}

// Sessions-per-partner over all of history. A partner is any ed_pubkey
// observed via signed-hello in a session (sessions.peer_pubkeys, already a
// deduped per-session set). Names resolve from the friends table; an
// unpaired/removed peer falls back to a short pubkey label. Unknowns are
// NOT filtered out — "counts match what the tables contain" wants literal
// counts. Sorted by session count desc, then name asc for a stable order;
// the full list is returned and the view caps the display.
export function topStudyPartners(
  sessions: readonly SessionRecord[],
  friends: readonly Friend[]
): StudyPartner[] {
  const nameByEd = new Map<string, string>()
  for (const f of friends) {
    const name = f.display_name?.trim()
    if (name) nameByEd.set(f.ed_pubkey_hex, name)
  }

  const counts = new Map<string, number>()
  for (const s of sessions) {
    for (const ed of parsePeerPubkeys(s.peer_pubkeys)) {
      counts.set(ed, (counts.get(ed) ?? 0) + 1)
    }
  }

  return Array.from(counts.entries())
    .map(([edPubkeyHex, sessionCount]) => ({
      edPubkeyHex,
      name: nameByEd.get(edPubkeyHex) ?? `Peer ${edPubkeyHex.slice(0, 6)}`,
      sessions: sessionCount,
    }))
    .sort((a, b) => b.sessions - a.sessions || a.name.localeCompare(b.name))
}

export type PartnerStudyTotals = {
  sessions: number
  minutes: number
  // Exact friends.last_studied_with when it is current; otherwise the most
  // recent session start at which this peer appeared is the lower bound.
  lastAt: number | null
}

export const NO_PARTNER_STUDY: PartnerStudyTotals = {
  sessions: 0,
  minutes: 0,
  lastAt: null,
}

// Sessions, study minutes and most-recent date per partner, keyed by
// ed_pubkey_hex. Same rows and the same "a partner is any peer in
// sessions.peer_pubkeys" rule as topStudyPartners, so Settings → Friends and
// the stats dashboard can never disagree about a count. New rows use measured
// overlap per peer. Rows without valid precision retain the legacy whole-
// session-per-peer interpretation rather than inventing historical timing.
export function partnerStudyTotals(
  sessions: readonly SessionRecord[],
  friends: readonly Friend[] = []
): Map<string, PartnerStudyTotals> {
  type Accumulated = {
    sessions: number
    durationMs: number
    lastAt: number | null
  }
  const byPeer = new Map<string, Accumulated>()
  for (const s of sessions) {
    const peers = parsePeerPubkeys(s.peer_pubkeys)
    const precise = decodePeerPresenceMsForPeers(s.peer_presence_ms, peers)
    const legacyDurationMs = studyMinutesForSession(s) * 60_000
    const logicalDurationMs = logicalStudyDurationMs(s)
    for (const ed of peers) {
      const prev = byPeer.get(ed) ?? {
        sessions: 0,
        durationMs: 0,
        lastAt: null,
      }
      byPeer.set(ed, {
        sessions: prev.sessions + 1,
        // 007 rows preserve the logical duration below one minute. Reconcile
        // a stale durable total with the minute/presence lower bounds before
        // using it as a cap; pre-007 maps have no matching total precision,
        // so preserve their existing exact overlap rather than rounding it
        // down to zero.
        durationMs:
          prev.durationMs +
          (precise?.get(ed) === undefined
            ? legacyDurationMs
            : logicalDurationMs === null
              ? precise.get(ed)!
              : Math.min(precise.get(ed)!, logicalDurationMs)),
        lastAt:
          s.started_at == null
            ? prev.lastAt
            : Math.max(prev.lastAt ?? s.started_at, s.started_at),
      })
    }
  }

  // New sessions update this column when the real peer-overlap interval
  // closes. Prefer that exact value without letting a failed/stale best-effort
  // update undercut the session-start evidence above.
  for (const friend of friends) {
    const total = byPeer.get(friend.ed_pubkey_hex)
    if (total && friend.last_studied_with !== null) {
      // Presence persistence is best-effort. A stale friend row must never
      // rewind the date below a newer session we can already prove happened;
      // for healthy new rows the exact interval close is later than its start
      // and therefore wins this lower-bound comparison.
      total.lastAt = Math.max(
        total.lastAt ?? friend.last_studied_with,
        friend.last_studied_with
      )
    }
  }

  return new Map(
    Array.from(byPeer, ([peer, total]) => [
      peer,
      {
        sessions: total.sessions,
        // Aggregate exact milliseconds across rows before rounding so short
        // overlaps are not discarded once per session.
        minutes: Math.floor(total.durationMs / 60_000),
        lastAt: total.lastAt,
      },
    ])
  )
}

export type ScoreSummary = {
  // Rounded mean of every session that recorded a score, or null when no
  // session has one (V1 / AI-off history).
  average: number | null
  scoredSessions: number
}

export function averageScore(sessions: readonly SessionRecord[]): ScoreSummary {
  const scores = sessions
    .map((s) => s.score)
    .filter((v): v is number => v != null)
  if (scores.length === 0) return { average: null, scoredSessions: 0 }
  const sum = scores.reduce((acc, v) => acc + v, 0)
  return {
    average: Math.round(sum / scores.length),
    scoredSessions: scores.length,
  }
}

export type StatsSummary = {
  totalSessions: number
  daily: DailyFocus[]
  streak: number
  partners: StudyPartner[]
  score: ScoreSummary
  heatmap: StudyHeatmap
}

// Single entry point the Dashboard shell calls once per load. `now` is
// injectable so the trailing-30-day window and the streak grace are
// deterministic under test.
export function computeStats(
  sessions: readonly SessionRecord[],
  friends: readonly Friend[],
  now: number,
  timeZone?: string,
  locale?: string
): StatsSummary {
  return {
    totalSessions: sessions.length,
    daily: studyMinutesPerDay(sessions, now, timeZone),
    streak: computeStreak(sessions, now, timeZone),
    partners: topStudyPartners(sessions, friends),
    score: averageScore(sessions),
    heatmap: buildStudyHeatmap(sessions, now, timeZone, locale),
  }
}

// R3 — stats CSV export rows, derived entirely from a computed StatsSummary
// (no re-query). Three sections in one file: the headline summary tiles
// (total sessions, streak, average score, scored sessions), then the
// trailing-30-day daily study-minutes series, then the all-time per-partner
// session counts. Pure so the exact layout is unit-pinned; the view hands the
// result to buildCsv + saveTextFile.
export type StatsCsv = {
  header: string[]
  rows: (string | number)[][]
}

export function buildStatsCsvModel(summary: StatsSummary): StatsCsv {
  const header = ['section', 'key', 'value']
  const rows: (string | number)[][] = []
  rows.push(['summary', 'total_sessions', summary.totalSessions])
  rows.push(['summary', 'streak_days', summary.streak])
  rows.push(['summary', 'average_score', summary.score.average ?? ''])
  rows.push(['summary', 'scored_sessions', summary.score.scoredSessions])
  for (const d of summary.daily) {
    rows.push(['daily_study_minutes', d.day, d.minutes])
  }
  for (const p of summary.partners) {
    rows.push(['partner_sessions', p.name, p.sessions])
  }
  return { header, rows }
}
