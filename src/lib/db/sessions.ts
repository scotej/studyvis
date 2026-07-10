// Typed wrappers over the Rust `sessions_*` commands (local SQLite session
// history). Two near-identical shapes on purpose: `SessionRow` (camelCase) is
// the JS→Rust INSERT input — Tauri's invoke layer expects camelCase keys and
// matches them to the command's snake_case parameters — while `SessionRecord`
// (snake_case) is serde's response shape on reads. Don't merge them.

import { invoke } from '@tauri-apps/api/core'

export type SessionRow = {
  id: string
  startedAt: number
  endedAt: number
  totalMinutes: number
  // JSON-array string of every ed_pubkey_hex observed via signed-hello in
  // this session, sorted lexicographically (canonical regardless of join
  // order). NULL when no hello was received — solo session or pre-V1-P9.
  peerPubkeys: string | null
  // V2-P8 report fields. Populated by the leave handler once the post-
  // session report runs; the V1 lifecycle insert leaves them null and the
  // Rust upsert preserves null-overrides via COALESCE.
  declaredTopic?: string | null
  score?: number | null
  focusedPct?: number | null
  generatedAt?: number | null
  // #47 D5 — AI data-quality counters (003 migration); null = counts unknown
  // (AI off, or a row written by an older build).
  confidentSamples?: number | null
  skippedSamples?: number | null
}

// Shape returned by `sessions_list` / `sessions_get`. Tauri auto-camelCases
// parameter names on JS→Rust invokes, but the response is serde's serialized
// struct, which uses Rust's snake_case field names verbatim.
export type SessionRecord = {
  id: string
  started_at: number | null
  ended_at: number | null
  total_minutes: number | null
  peer_pubkeys: string | null
  declared_topic: string | null
  score: number | null
  focused_pct: number | null
  generated_at: number | null
  confident_samples: number | null
  skipped_samples: number | null
}

export async function sessionsInsert(row: SessionRow): Promise<void> {
  await invoke('sessions_insert', {
    id: row.id,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    totalMinutes: row.totalMinutes,
    peerPubkeys: row.peerPubkeys,
    declaredTopic: row.declaredTopic ?? null,
    score: row.score ?? null,
    focusedPct: row.focusedPct ?? null,
    generatedAt: row.generatedAt ?? null,
    confidentSamples: row.confidentSamples ?? null,
    skippedSamples: row.skippedSamples ?? null,
  })
}

export async function listSessions(): Promise<SessionRecord[]> {
  return invoke<SessionRecord[]>('sessions_list')
}

export async function sessionsGet(id: string): Promise<SessionRecord | null> {
  return invoke<SessionRecord | null>('sessions_get', { id })
}

// R4 — deletes the session row + its audit_events in one Rust transaction.
// `id` is the session topic.
export async function sessionsDelete(id: string): Promise<void> {
  await invoke('sessions_delete', { id })
}

// R4 — clears every session row and all audit_events in one Rust transaction.
export async function sessionsClearAll(): Promise<void> {
  await invoke('sessions_clear_all')
}
