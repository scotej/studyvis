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

// Compact, locale-free axis label derived straight from the key so the
// chart and the tests agree on the exact string.
function shortDayLabel(key: string): string {
  const [, m, d] = key.split('-').map(Number)
  return `${m}/${d}`
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
  const totals = new Map<string, number>()
  for (const s of sessions) {
    if (s.started_at == null) continue
    const key = dayKey(s.started_at, timeZone)
    totals.set(key, (totals.get(key) ?? 0) + studyMinutesForSession(s))
  }
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
  const qualifying = new Set<string>()
  for (const s of sessions) {
    if (s.started_at == null) continue
    if ((s.total_minutes ?? 0) >= STREAK_MIN_MINUTES) {
      qualifying.add(dayKey(s.started_at, timeZone))
    }
  }
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
}

// Single entry point the Dashboard shell calls once per load. `now` is
// injectable so the trailing-30-day window and the streak grace are
// deterministic under test.
export function computeStats(
  sessions: readonly SessionRecord[],
  friends: readonly Friend[],
  now: number,
  timeZone?: string
): StatsSummary {
  return {
    totalSessions: sessions.length,
    daily: studyMinutesPerDay(sessions, now, timeZone),
    streak: computeStreak(sessions, now, timeZone),
    partners: topStudyPartners(sessions, friends),
    score: averageScore(sessions),
  }
}

// R3 — stats CSV export rows, derived entirely from a computed StatsSummary
// (no re-query). Two sections in one file: the trailing-30-day daily
// study-minutes series, then the all-time per-partner session counts. Pure
// so the exact layout is unit-pinned; the view hands the result to
// buildCsv + saveTextFile.
export type StatsCsv = {
  header: string[]
  rows: (string | number)[][]
}

export function buildStatsCsvModel(summary: StatsSummary): StatsCsv {
  const header = ['section', 'key', 'value']
  const rows: (string | number)[][] = []
  for (const d of summary.daily) {
    rows.push(['daily_study_minutes', d.day, d.minutes])
  }
  for (const p of summary.partners) {
    rows.push(['partner_sessions', p.name, p.sessions])
  }
  return { header, rows }
}
