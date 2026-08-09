import { describe, expect, test, vi } from 'vitest'

import type { AuditEventRecord } from '@/lib/db/audit'
import { sessionsGet, type SessionRecord } from '@/lib/db/sessions'

const ALICE = 'a'.repeat(64)
const BOB = 'b'.repeat(64)

const session: SessionRecord = {
  id: 'saved-session',
  started_at: 1_700_000_000_000,
  ended_at: 1_700_000_300_000,
  total_minutes: 5,
  peer_pubkeys: JSON.stringify([BOB]),
  declared_topic: 'Calculus',
  score: 90,
  focused_pct: 0.8,
  generated_at: 1_700_000_300_000,
  confident_samples: 5,
  skipped_samples: 0,
  ai_enabled: 1,
  local_ed_pubkey: ALICE,
  local_display_name: 'Alice at session time',
}

const events: AuditEventRecord[] = [
  {
    session_id: session.id,
    ts: session.started_at!,
    who: ALICE,
    kind: 'ai_warning',
    detail: JSON.stringify({ severity: 'mild', reasoning: 'Alice event' }),
    sig: 'alice-warning',
  },
  {
    session_id: session.id,
    ts: session.started_at! + 1_000,
    who: BOB,
    kind: 'ai_warning',
    detail: JSON.stringify({ severity: 'mild', reasoning: 'Bob event' }),
    sig: 'bob-warning',
  },
]

vi.mock('@/lib/db/sessions', () => ({
  sessionsGet: vi.fn(async () => session),
}))
vi.mock('@/lib/db/audit', () => ({
  auditEventsListForSession: vi.fn(async () => events),
}))
vi.mock('@/lib/db/friends', () => ({
  listFriends: vi.fn(async () => []),
}))

import { loadReportData } from '@/features/session/reportLoader'
import { deriveTopDistractions } from '@/features/session/reportData'
import { serializeReportToText } from '@/features/session/reportSerialize'
import { strings } from '@/strings'

describe('loadReportData historical owner provenance', () => {
  test('keeps identity A as the local owner after a different identity is active', async () => {
    // A current identity B is deliberately absent from the loader API. The
    // saved session's immutable owner A is the only authority for history.
    const data = await loadReportData(session.id)

    expect(data.myEdPubkeyHex).toBe(ALICE)
    expect(data.nameByEdPubkey[ALICE]).toBe('Alice at session time')
    expect(deriveTopDistractions(data.auditEvents, data.myEdPubkeyHex)).toEqual(
      [expect.objectContaining({ reasoning: 'Alice event' })]
    )
    expect(serializeReportToText(data)).toContain('### You')
  })

  test('legacy rows stay explicitly unknown instead of assigning local events to a new identity', async () => {
    const legacy: SessionRecord = {
      ...session,
      local_ed_pubkey: null,
      local_display_name: null,
    }
    vi.mocked(sessionsGet).mockResolvedValueOnce(legacy)
    const data = await loadReportData(legacy.id)

    expect(data.myEdPubkeyHex).toBeNull()
    expect(deriveTopDistractions(data.auditEvents, data.myEdPubkeyHex)).toEqual(
      []
    )
    const text = serializeReportToText(data)
    expect(text).toContain(strings.report.identityUnavailable)
    expect(text).not.toContain(strings.report.sections.distractions.empty)
  })
})
