// #99 — the year heatmap's pure data layer. Every case pins an explicit
// timeZone + locale so the grid, the day bucketing and the month labels are
// deterministic wherever the suite runs (same discipline as stats-data.test.ts).

import { describe, expect, test } from 'vitest'

import {
  buildStudyHeatmap,
  computeLongestStreak,
  heatmapLevel,
  HEATMAP_WEEKS,
  weekdayIndex,
} from '@/features/stats/statsData'
import type { SessionRecord } from '@/lib/db/sessions'

const ZONE = 'UTC'
const LOCALE = 'en-US'
const DAY = 86_400_000
// 2026-07-28T12:00:00Z — a Tuesday, so the current week is partial and the
// grid has to leave the rest of it blank.
const NOW = Date.UTC(2026, 6, 28, 12, 0, 0)

let n = 0
function session(over: Partial<SessionRecord> = {}): SessionRecord {
  n += 1
  return {
    id: `s${n}`,
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
    ai_enabled: null,
    ...over,
  }
}

function daysAgo(days: number, minutes: number): SessionRecord {
  return session({ started_at: NOW - days * DAY, total_minutes: minutes })
}

describe('weekdayIndex', () => {
  test('0 is Sunday and the count is DST-immune', () => {
    expect(weekdayIndex('2026-07-26')).toBe(0)
    expect(weekdayIndex('2026-07-28')).toBe(2)
    // Spans the US spring-forward Sunday; a wall-clock implementation would
    // slip a day here.
    expect(weekdayIndex('2026-03-08')).toBe(0)
    expect(weekdayIndex('2026-03-09')).toBe(1)
  })
})

describe('heatmapLevel', () => {
  test('maps minutes onto the five documented bands', () => {
    expect(heatmapLevel(0)).toBe(0)
    expect(heatmapLevel(1)).toBe(1)
    expect(heatmapLevel(29)).toBe(1)
    expect(heatmapLevel(30)).toBe(2)
    expect(heatmapLevel(59)).toBe(2)
    expect(heatmapLevel(60)).toBe(3)
    expect(heatmapLevel(119)).toBe(3)
    expect(heatmapLevel(120)).toBe(4)
    expect(heatmapLevel(600)).toBe(4)
  })
})

describe('buildStudyHeatmap grid shape', () => {
  test('is 53 Sunday-first columns of 7, ending on today', () => {
    const map = buildStudyHeatmap([], NOW, ZONE, LOCALE)
    expect(map.weeks).toHaveLength(HEATMAP_WEEKS)
    for (const week of map.weeks) expect(week).toHaveLength(7)
    expect(map.weeks[0][0]?.day).toBe('2025-07-27')
    expect(weekdayIndex('2025-07-27')).toBe(0)
    // Today is a Tuesday: its column holds Sunday, Monday, today, then blanks.
    const last = map.weeks[HEATMAP_WEEKS - 1]
    expect(last[2]?.day).toBe('2026-07-28')
    expect(last.slice(3)).toEqual([null, null, null, null])
  })

  test('covers at least a full year of real days', () => {
    const map = buildStudyHeatmap([], NOW, ZONE, LOCALE)
    // 52 whole weeks + Sunday..Tuesday of the current one.
    expect(map.daysInWindow).toBe(52 * 7 + 3)
    expect(map.daysInWindow).toBeGreaterThanOrEqual(365)
  })

  test('labels each column that opens a new month', () => {
    const map = buildStudyHeatmap([], NOW, ZONE, LOCALE)
    expect(map.months[0]).toEqual({ weekIndex: 0, label: 'Jul' })
    expect(map.months.map((m) => m.label)).toContain('Jan')
    // Jul 2025 through Jul 2026: twelve boundaries plus the opening column.
    expect(map.months).toHaveLength(13)
    // Strictly left to right, never two labels on one column.
    const indices = map.months.map((m) => m.weekIndex)
    expect([...indices].sort((a, b) => a - b)).toEqual(indices)
    expect(new Set(indices).size).toBe(indices.length)
  })
})

describe('buildStudyHeatmap totals', () => {
  test('sums every session that landed on the same local day', () => {
    const map = buildStudyHeatmap(
      [daysAgo(0, 20), daysAgo(0, 25), daysAgo(3, 90)],
      NOW,
      ZONE,
      LOCALE
    )
    const cells = map.weeks.flat().filter((c) => c !== null)
    const today = cells.find((c) => c.day === '2026-07-28')
    expect(today?.minutes).toBe(45)
    expect(today?.level).toBe(2)
    expect(map.daysStudied).toBe(2)
    expect(map.totalMinutes).toBe(135)
    expect(map.busiest?.day).toBe('2026-07-25')
    expect(map.busiest?.minutes).toBe(90)
  })

  test('a day with only zero-minute sessions does not count as studied', () => {
    const map = buildStudyHeatmap([daysAgo(0, 0)], NOW, ZONE, LOCALE)
    expect(map.daysStudied).toBe(0)
    expect(map.totalMinutes).toBe(0)
    expect(map.busiest).toBeNull()
  })

  test('ignores sessions outside the window and rows with no start', () => {
    const map = buildStudyHeatmap(
      [daysAgo(400, 120), session({ started_at: null, total_minutes: 60 })],
      NOW,
      ZONE,
      LOCALE
    )
    expect(map.daysStudied).toBe(0)
    expect(map.totalMinutes).toBe(0)
    // The out-of-window session is still real history, so it may not be
    // silently dropped from the all-time streak.
    expect(map.longestStreak).toBe(1)
  })
})

describe('computeLongestStreak', () => {
  test('is the longest run anywhere in history, not the live one', () => {
    const sessions = [
      // A five-day run last spring...
      daysAgo(200, 60),
      daysAgo(199, 60),
      daysAgo(198, 60),
      daysAgo(197, 60),
      daysAgo(196, 60),
      // ...and a two-day one that is still going.
      daysAgo(1, 60),
      daysAgo(0, 60),
    ]
    expect(computeLongestStreak(sessions, ZONE)).toBe(5)
  })

  test('counts a run once however many sessions each day holds', () => {
    const sessions = [daysAgo(2, 30), daysAgo(2, 40), daysAgo(1, 30)]
    expect(computeLongestStreak(sessions, ZONE)).toBe(2)
  })

  test('only days meeting the streak minimum count', () => {
    // 24 minutes is under STREAK_MIN_MINUTES, so it breaks the run rather
    // than extending it.
    const sessions = [daysAgo(3, 30), daysAgo(2, 24), daysAgo(1, 30)]
    expect(computeLongestStreak(sessions, ZONE)).toBe(1)
  })

  test('is 0 with no qualifying history', () => {
    expect(computeLongestStreak([], ZONE)).toBe(0)
    expect(computeLongestStreak([daysAgo(0, 5)], ZONE)).toBe(0)
  })
})
