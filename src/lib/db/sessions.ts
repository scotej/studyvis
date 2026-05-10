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
}

// Shape returned by `sessions_list`. Tauri auto-camelCases parameter names
// on JS→Rust invokes, but the response is serde's serialized struct, which
// uses Rust's snake_case field names verbatim.
export type SessionRecord = {
  id: string
  started_at: number | null
  ended_at: number | null
  total_minutes: number | null
  peer_pubkeys: string | null
}

export async function sessionsInsert(row: SessionRow): Promise<void> {
  await invoke('sessions_insert', {
    id: row.id,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    totalMinutes: row.totalMinutes,
    peerPubkeys: row.peerPubkeys,
  })
}

export async function listSessions(): Promise<SessionRecord[]> {
  return invoke<SessionRecord[]>('sessions_list')
}
