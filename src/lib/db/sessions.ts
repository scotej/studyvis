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
  totalMinutes: number | null
  // Exact accumulated awake study duration. New writers keep sub-minute
  // residue here while totalMinutes remains the derived display/stats count.
  totalDurationMs: number | null
  // JSON-array string of every ed_pubkey_hex observed via signed-hello in
  // this session, sorted lexicographically (canonical regardless of join
  // order). NULL when no hello was received — solo session or pre-V1-P9.
  peerPubkeys: string | null
  // Canonical JSON object of ed_pubkey_hex -> cumulative authenticated
  // overlap milliseconds. New rows always write an object (including `{}`);
  // null means legacy/unknown precision.
  peerPresenceMs?: string | null
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
  // I83 — was AI focus detection on for this session? (004 migration.)
  // 1 = on, 0 = off, null = unknown. Every other AI column reads null both
  // when AI was off and when it was on but never produced a check; this is
  // what lets the report tell those two apart.
  aiEnabled?: number | null
  // Immutable local-owner provenance captured when the logical session first
  // starts. Historical reports must never substitute whichever identity is
  // active when they are opened.
  localEdPubkey?: string | null
  localDisplayName?: string | null
  // A same-topic stint whose in-memory score machine was not continuous (for
  // example after app restart) must replace, including clear, focus fields
  // rather than letting SQLite retain a misleading last-stint score.
  replaceFocusMetrics?: boolean
}

// Shape returned by `sessions_list` / `sessions_get`. Tauri auto-camelCases
// parameter names on JS→Rust invokes, but the response is serde's serialized
// struct, which uses Rust's snake_case field names verbatim.
export type SessionRecord = {
  id: string
  started_at: number | null
  ended_at: number | null
  total_minutes: number | null
  // Null/omitted means the row predates durable fractional-duration storage.
  total_duration_ms?: number | null
  peer_pubkeys: string | null
  // Optional at the TS boundary for mixed frontend/backend builds. Missing and
  // NULL both mean the row predates precise per-peer duration accounting.
  peer_presence_ms?: string | null
  declared_topic: string | null
  score: number | null
  focused_pct: number | null
  generated_at: number | null
  confident_samples: number | null
  skipped_samples: number | null
  ai_enabled: number | null
  // Optional at the TypeScript boundary for mixed frontend/backend builds;
  // missing has the same unknown-owner meaning as NULL from the migration.
  local_ed_pubkey?: string | null
  local_display_name?: string | null
}

export async function sessionsInsert(row: SessionRow): Promise<void> {
  await invoke('sessions_insert', {
    id: row.id,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    totalMinutes: row.totalMinutes,
    totalDurationMs: row.totalDurationMs,
    peerPubkeys: row.peerPubkeys,
    peerPresenceMs: row.peerPresenceMs ?? null,
    declaredTopic: row.declaredTopic ?? null,
    score: row.score ?? null,
    focusedPct: row.focusedPct ?? null,
    generatedAt: row.generatedAt ?? null,
    confidentSamples: row.confidentSamples ?? null,
    skippedSamples: row.skippedSamples ?? null,
    aiEnabled: row.aiEnabled ?? null,
    localEdPubkey: row.localEdPubkey ?? null,
    localDisplayName: row.localDisplayName ?? null,
    replaceFocusMetrics: row.replaceFocusMetrics ?? false,
  })
}

// Recovery path for an indeterminate sessions_get result. The Rust command's
// INSERT ... ON CONFLICT DO NOTHING is atomic: a first-ever stint is retained,
// while an existing multi-stint row can never be rewound by stint-only data.
export async function sessionsInsertIfAbsent(
  row: SessionRow
): Promise<boolean> {
  return invoke<boolean>('sessions_insert_if_absent', {
    id: row.id,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    totalMinutes: row.totalMinutes,
    totalDurationMs: row.totalDurationMs,
    peerPubkeys: row.peerPubkeys,
    peerPresenceMs: row.peerPresenceMs ?? null,
    declaredTopic: row.declaredTopic ?? null,
    score: row.score ?? null,
    focusedPct: row.focusedPct ?? null,
    generatedAt: row.generatedAt ?? null,
    confidentSamples: row.confidentSamples ?? null,
    skippedSamples: row.skippedSamples ?? null,
    aiEnabled: row.aiEnabled ?? null,
    localEdPubkey: row.localEdPubkey ?? null,
    localDisplayName: row.localDisplayName ?? null,
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
