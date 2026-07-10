// V3-P1 — Pure data-transform tests for the local stats dashboard.
// Mirrors tests/unit/report-data.test.ts: the component renders the
// resolved summary, these tests pin the numbers against seeded rows so
// "all counts match what the underlying tables contain" is verifiable
// without a DOM.
//
// Determinism: every call passes timeZone 'UTC' and a fixed `now`, so the
// trailing-30-day window + streak grace are independent of the runner's
// clock and zone (no process.env.TZ hackery — the transforms take the
// zone as a parameter).

import { describe, expect, test } from 'vitest'

import type { Friend } from '@/lib/db/friends'
import type { SessionRecord } from '@/lib/db/sessions'
import {
  addDays,
  averageScore,
  computeStats,
  computeStreak,
  dayKey,
  studyMinutesForSession,
  studyMinutesPerDay,
  topStudyPartners,
} from '@/features/stats/statsData'

const TZ = 'UTC'
const DAY = 86_400_000
// "Today" anchored at noon UTC so whole-day subtraction never flips the
// UTC calendar date.
const NOW = Date.UTC(2026, 4, 18, 12, 0, 0) // 2026-05-18T12:00:00Z
const dayAgo = (n: number) => NOW - n * DAY
const KEY = (n: number) => dayKey(dayAgo(n), TZ)

let idCounter = 0
function session(over: Partial<SessionRecord> = {}): SessionRecord {
  idCounter += 1
  return {
    id: `s${idCounter}`,
    started_at: NOW,
    ended_at: null,
    total_minutes: 30,
    peer_pubkeys: null,
    declared_topic: null,
    score: null,
    focused_pct: null,
    generated_at: null,
    confident_samples: null,
    skipped_samples: null,
    ...over,
  }
}

function friend(edPubkeyHex: string, displayName: string | null): Friend {
  return {
    ed_pubkey_hex: edPubkeyHex,
    x_pubkey_hex: `x-${edPubkeyHex}`,
    display_name: displayName,
    paired_at: 1,
    last_studied_with: null,
  }
}

describe('dayKey / addDays', () => {
  test('dayKey formats YYYY-MM-DD in the given zone', () => {
    expect(dayKey(Date.UTC(2026, 0, 9, 23, 30), 'UTC')).toBe('2026-01-09')
  })
  test('addDays walks the calendar across a month boundary', () => {
    expect(addDays('2026-05-01', -1)).toBe('2026-04-30')
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDays('2026-05-18', -7)).toBe('2026-05-11')
  })
})

describe('studyMinutesForSession', () => {
  test('uses total_minutes; null becomes 0', () => {
    expect(studyMinutesForSession(session({ total_minutes: 42 }))).toBe(42)
    expect(studyMinutesForSession(session({ total_minutes: null }))).toBe(0)
  })
})

describe('studyMinutesPerDay', () => {
  test('0 sessions → 30 zero-filled days, chronological, ending today', () => {
    const daily = studyMinutesPerDay([], NOW, TZ)
    expect(daily).toHaveLength(30)
    expect(daily[0].day).toBe(KEY(29)) // 2026-04-19, oldest in window
    expect(daily[29].day).toBe(KEY(0)) // 2026-05-18, today
    expect(daily.every((d) => d.minutes === 0)).toBe(true)
    expect(daily[29].label).toBe('5/18')
  })

  test('1 session today → only the last bar is non-zero', () => {
    const daily = studyMinutesPerDay(
      [session({ total_minutes: 25, started_at: NOW })],
      NOW,
      TZ
    )
    expect(daily).toHaveLength(30)
    expect(daily[29]).toMatchObject({ day: KEY(0), minutes: 25 })
    expect(daily.slice(0, 29).every((d) => d.minutes === 0)).toBe(true)
  })

  test('same-day sessions sum; out-of-window + null started_at excluded', () => {
    const sessions = [
      session({ total_minutes: 20, started_at: dayAgo(2) }),
      session({ total_minutes: 35, started_at: dayAgo(2) }), // same day → 55
      session({ total_minutes: 50, started_at: dayAgo(29) }), // edge: in window
      session({ total_minutes: 99, started_at: dayAgo(30) }), // just outside
      session({ total_minutes: 10, started_at: null }), // unplaceable
    ]
    const daily = studyMinutesPerDay(sessions, NOW, TZ)
    const byDay = Object.fromEntries(daily.map((d) => [d.day, d.minutes]))
    expect(byDay[KEY(2)]).toBe(55)
    expect(byDay[KEY(29)]).toBe(50)
    expect(byDay[KEY(30)]).toBeUndefined() // not in the 30-day window
    // Total across the chart equals the in-window, placeable minutes only.
    const charted = daily.reduce((acc, d) => acc + d.minutes, 0)
    expect(charted).toBe(55 + 50)
  })

  test('30+ sessions: every in-window day count matches the seeded rows', () => {
    // One session per day for 35 days back. Window keeps days 0..29.
    const sessions = Array.from({ length: 35 }, (_, n) =>
      session({ total_minutes: n + 1, started_at: dayAgo(n) })
    )
    const daily = studyMinutesPerDay(sessions, NOW, TZ)
    expect(daily).toHaveLength(30)
    for (let n = 0; n <= 29; n++) {
      const bar = daily.find((d) => d.day === KEY(n))
      expect(bar?.minutes).toBe(n + 1)
    }
    // Days 30..34 fall outside the window and contribute nothing.
    const charted = daily.reduce((acc, d) => acc + d.minutes, 0)
    const expected = Array.from({ length: 30 }, (_, n) => n + 1).reduce(
      (a, b) => a + b,
      0
    )
    expect(charted).toBe(expected)
  })
})

describe('computeStreak', () => {
  const q = (n: number) => session({ total_minutes: 30, started_at: dayAgo(n) })

  test('no qualifying sessions → 0', () => {
    expect(computeStreak([], NOW, TZ)).toBe(0)
    expect(
      computeStreak([session({ total_minutes: 10, started_at: NOW })], NOW, TZ)
    ).toBe(0)
  })

  test('exactly 25 min qualifies; 24 does not', () => {
    expect(
      computeStreak([session({ total_minutes: 25, started_at: NOW })], NOW, TZ)
    ).toBe(1)
    expect(
      computeStreak([session({ total_minutes: 24, started_at: NOW })], NOW, TZ)
    ).toBe(0)
  })

  test('today qualifies, yesterday empty → 1', () => {
    expect(computeStreak([q(0)], NOW, TZ)).toBe(1)
  })

  test('grace: yesterday qualifies, today empty → counts from yesterday', () => {
    expect(computeStreak([q(1)], NOW, TZ)).toBe(1)
  })

  test('only 2 days ago qualifies (today + yesterday empty) → 0', () => {
    expect(computeStreak([q(2)], NOW, TZ)).toBe(0)
  })

  test('5-day run ending yesterday, today empty → 5 (grace)', () => {
    const sessions = [q(1), q(2), q(3), q(4), q(5)]
    expect(computeStreak(sessions, NOW, TZ)).toBe(5)
  })

  test('run ending today; a gap breaks it', () => {
    // today, -1, -2 qualify, -3 missing, -4 qualifies → streak is 3.
    const sessions = [q(0), q(1), q(2), q(4)]
    expect(computeStreak(sessions, NOW, TZ)).toBe(3)
  })

  test('multiple sessions on the same day count that day once', () => {
    const sessions = [
      session({ total_minutes: 30, started_at: dayAgo(0) }),
      session({ total_minutes: 40, started_at: dayAgo(0) }),
      q(1),
    ]
    expect(computeStreak(sessions, NOW, TZ)).toBe(2)
  })

  test('null started_at is ignored', () => {
    expect(
      computeStreak(
        [session({ total_minutes: 60, started_at: null }), q(0)],
        NOW,
        TZ
      )
    ).toBe(1)
  })
})

describe('topStudyPartners', () => {
  const A = 'a'.repeat(64)
  const B = 'b'.repeat(64)
  const C = 'c'.repeat(64)

  test('counts sessions per pubkey and resolves friend names', () => {
    const sessions = [
      session({ peer_pubkeys: JSON.stringify([A, B]) }),
      session({ peer_pubkeys: JSON.stringify([A]) }),
      session({ peer_pubkeys: JSON.stringify([A, B]) }),
    ]
    const friends = [friend(A, 'Alice'), friend(B, 'Bo')]
    const partners = topStudyPartners(sessions, friends)
    expect(partners).toEqual([
      { edPubkeyHex: A, name: 'Alice', sessions: 3 },
      { edPubkeyHex: B, name: 'Bo', sessions: 2 },
    ])
  })

  test('unknown / unpaired pubkey falls back to a short label', () => {
    const sessions = [session({ peer_pubkeys: JSON.stringify([C]) })]
    const partners = topStudyPartners(sessions, [])
    expect(partners).toEqual([
      { edPubkeyHex: C, name: `Peer ${C.slice(0, 6)}`, sessions: 1 },
    ])
  })

  test('ties sort by name asc; null/blank/malformed peer_pubkeys ignored', () => {
    const sessions = [
      session({ peer_pubkeys: JSON.stringify([B]) }),
      session({ peer_pubkeys: JSON.stringify([A]) }),
      session({ peer_pubkeys: null }),
      session({ peer_pubkeys: 'not json' }),
      session({ peer_pubkeys: JSON.stringify('A') }), // not an array
    ]
    const partners = topStudyPartners(sessions, [
      friend(A, 'Alice'),
      friend(B, 'Bo'),
    ])
    expect(partners.map((p) => p.name)).toEqual(['Alice', 'Bo'])
    expect(partners.every((p) => p.sessions === 1)).toBe(true)
  })

  test('a duplicate pubkey within one session counts once for it', () => {
    const sessions = [session({ peer_pubkeys: JSON.stringify([A, A, B]) })]
    const partners = topStudyPartners(sessions, [])
    const alice = partners.find((p) => p.edPubkeyHex === A)
    expect(alice?.sessions).toBe(1)
  })

  test('friend with blank display name uses the fallback label', () => {
    const sessions = [session({ peer_pubkeys: JSON.stringify([A]) })]
    const partners = topStudyPartners(sessions, [friend(A, '   ')])
    expect(partners[0].name).toBe(`Peer ${A.slice(0, 6)}`)
  })
})

describe('averageScore', () => {
  test('no scored sessions → null average', () => {
    expect(averageScore([])).toEqual({ average: null, scoredSessions: 0 })
    expect(
      averageScore([session({ score: null }), session({ score: null })])
    ).toEqual({ average: null, scoredSessions: 0 })
  })

  test('excludes null scores and rounds the mean', () => {
    const sessions = [
      session({ score: 90 }),
      session({ score: 81 }),
      session({ score: null }), // AI-off session, excluded
      session({ score: 70 }),
    ]
    // mean(90,81,70) = 80.33 → 80, across 3 scored sessions
    expect(averageScore(sessions)).toEqual({
      average: 80,
      scoredSessions: 3,
    })
  })

  test('rounds half up', () => {
    expect(
      averageScore([session({ score: 80 }), session({ score: 81 })])
    ).toEqual(
      { average: 81, scoredSessions: 2 } // 80.5 → 81
    )
  })

  test('a zero score still counts as scored', () => {
    expect(averageScore([session({ score: 0 })])).toEqual({
      average: 0,
      scoredSessions: 1,
    })
  })
})

describe('computeStats (acceptance: 0 / 1 / 30+ sessions)', () => {
  test('0 sessions', () => {
    const s = computeStats([], [], NOW, TZ)
    expect(s.totalSessions).toBe(0)
    expect(s.daily).toHaveLength(30)
    expect(s.daily.every((d) => d.minutes === 0)).toBe(true)
    expect(s.streak).toBe(0)
    expect(s.partners).toEqual([])
    expect(s.score).toEqual({ average: null, scoredSessions: 0 })
  })

  test('1 session', () => {
    const A = 'a'.repeat(64)
    const s = computeStats(
      [
        session({
          total_minutes: 25,
          started_at: NOW,
          score: 88,
          peer_pubkeys: JSON.stringify([A]),
        }),
      ],
      [friend(A, 'Alice')],
      NOW,
      TZ
    )
    expect(s.totalSessions).toBe(1)
    expect(s.daily[29].minutes).toBe(25)
    expect(s.streak).toBe(1)
    expect(s.partners).toEqual([{ edPubkeyHex: A, name: 'Alice', sessions: 1 }])
    expect(s.score).toEqual({ average: 88, scoredSessions: 1 })
  })

  test('30+ sessions: aggregates match the seeded table contents', () => {
    const A = 'a'.repeat(64)
    const B = 'b'.repeat(64)
    // 32 sessions, one per day for the last 32 days. Even days study with
    // A, the rest with B. Half carry a score.
    const sessions = Array.from({ length: 32 }, (_, n) =>
      session({
        total_minutes: 30,
        started_at: dayAgo(n),
        score: n % 2 === 0 ? 100 : null,
        peer_pubkeys: JSON.stringify([n % 2 === 0 ? A : B]),
      })
    )
    const s = computeStats(
      sessions,
      [friend(A, 'Alice'), friend(B, 'Bo')],
      NOW,
      TZ
    )
    expect(s.totalSessions).toBe(32)
    // Days 0..29 are charted (30 bars), each seeded with 30 min. The
    // chart is windowed to 30 days; the streak is NOT — it counts every
    // consecutive qualifying day.
    expect(s.daily).toHaveLength(30)
    expect(s.daily.every((d) => d.minutes === 30)).toBe(true)
    // 32 consecutive qualifying days ending today → streak 32.
    expect(s.streak).toBe(32)
    // A appears on even days (0,2,...,30) = 16 sessions; B on odd = 16.
    const partnerCounts = Object.fromEntries(
      s.partners.map((p) => [p.name, p.sessions])
    )
    expect(partnerCounts.Alice).toBe(16)
    expect(partnerCounts.Bo).toBe(16)
    // 16 even-day sessions carry score 100; the rest are null.
    expect(s.score).toEqual({ average: 100, scoredSessions: 16 })
  })
})
