// #236 — typed wrappers over the `session_timeline_*` commands (the written
// post-session narrative). Same two-shape convention as src/lib/db/sessions.ts:
// invoke arguments are camelCase (Tauri maps them to the Rust snake_case
// parameters), while the response is serde's snake_case struct verbatim.

import { invoke } from '@tauri-apps/api/core'

// How the stored entries were produced. The report renders a note for anything
// other than 'model' so it never claims the AI wrote a narrative it didn't.
export type SessionTimelineSource = 'model' | 'mixed' | 'observations'

export type SessionTimelineRecord = {
  session_id: string
  generated_at: number
  model_id: string | null
  // Widened to string on purpose: a row written by a newer build could carry a
  // source this one doesn't know. Callers narrow with `isTimelineSource`.
  source: string
  // JSON array of `{ start_min, end_min, summary }`.
  entries: string
  // 1 when the journal held more checks than the write-up covers (SQLite has
  // no boolean type, so this crosses the boundary as an integer).
  truncated: number
}

export function isTimelineSource(
  value: string
): value is SessionTimelineSource {
  return value === 'model' || value === 'mixed' || value === 'observations'
}

export async function sessionTimelineGet(
  sessionId: string
): Promise<SessionTimelineRecord | null> {
  return invoke<SessionTimelineRecord | null>('session_timeline_get', {
    sessionId,
  })
}

export async function sessionTimelineSave(row: {
  sessionId: string
  generatedAt: number
  modelId: string | null
  source: SessionTimelineSource
  entries: string
  truncated: boolean
}): Promise<void> {
  await invoke('session_timeline_save', {
    sessionId: row.sessionId,
    generatedAt: row.generatedAt,
    modelId: row.modelId,
    source: row.source,
    entries: row.entries,
    truncated: row.truncated,
  })
}
