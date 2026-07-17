import { beforeEach, describe, expect, test, vi } from 'vitest'

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
      score: null,
      focused_pct: null,
      generated_at: null,
      confident_samples: null,
      skipped_samples: null,
    }
  }),
  sessionsInsert: vi.fn(
    async (row: { id: string } & Record<string, unknown>) => {
      db.set(row.id, row)
    }
  ),
}))

vi.mock('@/features/ai/focusStore', () => ({
  snapshotFocusForReport: () => ({
    score: null,
    focusedPct: null,
    confidentSamples: null,
    skippedSamples: null,
  }),
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

async function runStint(startedAt: number, endedAt: number): Promise<void> {
  useSessionStore.getState().begin({
    sessionTopic: 'topic-1',
    sessionPassword: 'pw',
    isHost: false,
    startedAt,
    room: fakeRoom(),
    leave: async () => {},
  })
  const leave = buildLeaveHandler({
    room: fakeRoom(),
    topic: 'topic-1',
    startedAt,
  })
  vi.setSystemTime(endedAt)
  await leave()
}

describe('re-entry merge across leave cycles', () => {
  beforeEach(() => {
    db.clear()
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
