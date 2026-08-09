import { beforeEach, describe, expect, test, vi } from 'vitest'

import type { FocusSnapshot } from '@/features/ai/focusStore'

// Re-entering the same session room (Rejoin after a grace auto-end, or a
// guest re-invited to a session they left) runs a second leave cycle against
// the same topic-keyed sessions row. The Rust upsert overwrites
// started_at/ended_at/total_minutes authoritatively (I17), so the caller
// must accumulate across stints — otherwise a 60-minute stint followed by a
// 10-minute rejoin persists as 10 minutes, under-counting stats and
// breaking streaks.

const db = new Map<string, Record<string, unknown>>()

vi.mock('@/lib/db/sessions', () => ({
  sessionsGet: vi.fn(async (id: string) => {
    const row = db.get(id)
    if (!row) return null
    return {
      id,
      started_at: row.startedAt ?? null,
      ended_at: row.endedAt ?? null,
      total_minutes: row.totalMinutes ?? null,
      peer_pubkeys: row.peerPubkeys ?? null,
      declared_topic: null,
      score: row.score ?? null,
      focused_pct: row.focusedPct ?? null,
      generated_at: null,
      confident_samples: row.confidentSamples ?? null,
      skipped_samples: row.skippedSamples ?? null,
      ai_enabled: row.aiEnabled ?? null,
      local_ed_pubkey: null,
      local_display_name: null,
    }
  }),
  sessionsInsert: vi.fn(
    async (row: { id: string } & Record<string, unknown>) => {
      db.set(row.id, row)
    }
  ),
}))

const focus: { snapshot: FocusSnapshot } = {
  snapshot: {
    score: null,
    focusedPct: null,
    confidentSamples: null,
    skippedSamples: null,
    aiEnabled: 0,
  },
}

vi.mock('@/features/ai/focusStore', () => ({
  snapshotFocusForReport: () => focus.snapshot,
}))

import {
  buildLeaveHandler,
  mergeSessionStints,
} from '@/features/session/lifecycle'
import type { TopicRoom } from '@/lib/trystero'
import { useSessionStore } from '@/stores/sessionStore'

const T0 = 1_700_000_000_000
const MIN = 60_000

function fakeRoom(): TopicRoom {
  return { leave: async () => {} } as unknown as TopicRoom
}

// `mono`, when given, models the monotonic clock: awake elapsed in ms, which
// on a machine that slept mid-session is far less than endedAt - startedAt.
async function runStint(
  startedAt: number,
  endedAt: number,
  mono?: { awakeMs: number },
  continuesFocus = false
): Promise<void> {
  const startedAtMono = 5_000
  useSessionStore.getState().begin({
    sessionTopic: 'topic-1',
    sessionPassword: 'pw',
    isHost: false,
    startedAt,
    startedAtMono: mono ? startedAtMono : undefined,
    room: fakeRoom(),
    leave: async () => {},
  })
  const leave = buildLeaveHandler({
    room: fakeRoom(),
    topic: 'topic-1',
    startedAt,
    startedAtMono: mono ? startedAtMono : undefined,
    monotonicNow: mono ? () => startedAtMono + mono.awakeMs : undefined,
    continuesFocus,
  })
  vi.setSystemTime(endedAt)
  await leave()
}

describe('re-entry merge across leave cycles', () => {
  beforeEach(() => {
    db.clear()
    focus.snapshot = {
      score: null,
      focusedPct: null,
      confidentSamples: null,
      skippedSamples: null,
      aiEnabled: 0,
    }
    useSessionStore.getState().reset()
    vi.useFakeTimers()
    return () => vi.useRealTimers()
  })

  test('a rejoin stint accumulates minutes instead of rewinding the row', async () => {
    // Stint 1: 45 minutes, ends via grace auto-end.
    await runStint(T0, T0 + 45 * MIN)
    expect(db.get('topic-1')).toMatchObject({
      startedAt: T0,
      totalMinutes: 45,
    })

    // Stint 2 (Rejoin): starts 2 minutes later, lasts 10 minutes. The second
    // upsert is the destructive write the merge exists to fix.
    const t2 = T0 + 47 * MIN
    await runStint(t2, t2 + 10 * MIN)
    expect(db.get('topic-1')).toMatchObject({
      startedAt: T0, // earliest stint anchors the report timeline
      totalMinutes: 55, // 45 + 10 — the 2-minute gap is not studied time
      endedAt: t2 + 10 * MIN,
    })
  })

  test('a rejoin persists focus metrics accumulated across both stints', async () => {
    // The first stint has 4 focused samples out of 10. SessionView keeps this
    // focus-store state when the same logical session rejoins.
    focus.snapshot = {
      score: 93,
      focusedPct: 4 / 10,
      confidentSamples: 10,
      skippedSamples: 2,
      aiEnabled: 1,
    }
    await runStint(T0, T0 + 45 * MIN)

    // Five more confident samples (all focused) and one skipped check ran in
    // the second stint. This is the continuous store snapshot, not a
    // last-stint-only 5/5 = 100% value.
    focus.snapshot = {
      score: 91,
      focusedPct: 9 / 15,
      confidentSamples: 15,
      skippedSamples: 3,
      // The user turned AI off after the first stint. The cumulative session
      // still truthfully records that AI ran earlier.
      aiEnabled: 0,
    }
    const rejoinedAt = T0 + 47 * MIN
    await runStint(rejoinedAt, rejoinedAt + 10 * MIN, undefined, true)

    expect(db.get('topic-1')).toMatchObject({
      totalMinutes: 55,
      score: 91,
      focusedPct: 9 / 15,
      confidentSamples: 15,
      skippedSamples: 3,
      aiEnabled: 1,
    })
  })

  test('a same-topic stint without carried score state clears score and combines raw focus samples', async () => {
    focus.snapshot = {
      score: 93,
      focusedPct: 4 / 10,
      confidentSamples: 10,
      skippedSamples: 2,
      aiEnabled: 1,
    }
    await runStint(T0, T0 + 45 * MIN)

    // This models the app restarting before a guest receives the same invite:
    // the new score machine has only its own five samples. It is not valid to
    // attach this one-stint score to the 55-minute merged duration.
    focus.snapshot = {
      score: 98,
      focusedPct: 5 / 5,
      confidentSamples: 5,
      skippedSamples: 1,
      aiEnabled: 1,
    }
    const rejoinedAt = T0 + 47 * MIN
    await runStint(rejoinedAt, rejoinedAt + 10 * MIN)

    expect(db.get('topic-1')).toMatchObject({
      totalMinutes: 55,
      score: null,
      focusedPct: 9 / 15,
      confidentSamples: 15,
      skippedSamples: 3,
      replaceFocusMetrics: true,
    })
  })

  test('a legacy unknown AI state stays unknown after an AI-disabled stint', async () => {
    await runStint(T0, T0 + 45 * MIN)
    const legacy = db.get('topic-1')!
    legacy.aiEnabled = null
    legacy.confidentSamples = null
    legacy.skippedSamples = null

    const rejoinedAt = T0 + 47 * MIN
    await runStint(rejoinedAt, rejoinedAt + 10 * MIN)

    expect(db.get('topic-1')).toMatchObject({
      totalMinutes: 55,
      aiEnabled: null,
      replaceFocusMetrics: true,
    })
  })
})

// Wall-clock alone counted OS-sleep as study time: closing the lid on a
// 45-minute session and ending it in the morning persisted the whole
// overnight span, fabricating a streak day.
describe('study minutes ignore time the machine spent asleep', () => {
  beforeEach(() => {
    db.clear()
    useSessionStore.getState().reset()
    vi.useFakeTimers()
    return () => vi.useRealTimers()
  })

  test('an awake session records the full wall-clock span', async () => {
    await runStint(T0, T0 + 45 * MIN, { awakeMs: 45 * MIN })
    expect(db.get('topic-1')).toMatchObject({ totalMinutes: 45 })
  })

  test('a slept-through session records only the awake span', async () => {
    // 43 minutes of study, lid closed, ended 612 wall-clock minutes later.
    await runStint(T0, T0 + 612 * MIN, { awakeMs: 43 * MIN })
    expect(db.get('topic-1')).toMatchObject({ totalMinutes: 43 })
  })

  test('a wall clock stepped backward never yields negative minutes', async () => {
    // monotonic > wall (NTP correction mid-session): wall wins, clamped at 0.
    await runStint(T0, T0 - 5 * MIN, { awakeMs: 45 * MIN })
    expect(db.get('topic-1')).toMatchObject({ totalMinutes: 0 })
  })

  test('no monotonic origin falls back to the wall-clock span', async () => {
    await runStint(T0, T0 + 45 * MIN)
    expect(db.get('topic-1')).toMatchObject({ totalMinutes: 45 })
  })

  test('a slept-through rejoin stint still sums onto the prior stint', async () => {
    await runStint(T0, T0 + 45 * MIN, { awakeMs: 45 * MIN })
    const t2 = T0 + 47 * MIN
    await runStint(t2, t2 + 600 * MIN, { awakeMs: 10 * MIN })
    expect(db.get('topic-1')).toMatchObject({
      startedAt: T0,
      totalMinutes: 55,
    })
  })
})

describe('mergeSessionStints (pure)', () => {
  const stint = {
    startedAt: T0 + 10 * MIN,
    totalMinutes: 10,
    peerPubkeys: '["bb","aa"]' as string | null,
  }

  test('no prior row → stint passes through', () => {
    expect(mergeSessionStints(null, stint)).toEqual(stint)
  })

  test('merges start, minutes, and the sorted peer union', () => {
    const merged = mergeSessionStints(
      { started_at: T0, total_minutes: 45, peer_pubkeys: '["cc","aa"]' },
      stint
    )
    expect(merged.startedAt).toBe(T0)
    expect(merged.totalMinutes).toBe(55)
    expect(merged.peerPubkeys).toBe('["aa","bb","cc"]')
  })

  test('a peerless rejoin stint keeps the prior stint peers', () => {
    const merged = mergeSessionStints(
      { started_at: T0, total_minutes: 45, peer_pubkeys: '["cc"]' },
      { ...stint, peerPubkeys: null }
    )
    expect(merged.peerPubkeys).toBe('["cc"]')
  })

  test('NULL prior fields never poison the merge', () => {
    // schema allows NULL started_at/total_minutes on partial rows
    const merged = mergeSessionStints(
      { started_at: null, total_minutes: null, peer_pubkeys: null },
      stint
    )
    expect(merged.startedAt).toBe(stint.startedAt)
    expect(merged.totalMinutes).toBe(10)
    expect(merged.peerPubkeys).toBe('["aa","bb"]')
  })

  test('malformed stored peer JSON degrades to the stint peers', () => {
    const merged = mergeSessionStints(
      { started_at: T0, total_minutes: 1, peer_pubkeys: 'not-json' },
      stint
    )
    expect(merged.peerPubkeys).toBe('["aa","bb"]')
  })
})
