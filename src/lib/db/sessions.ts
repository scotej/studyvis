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

export async function sessionsInsert(row: SessionRow): Promise<void> {
  await invoke('sessions_insert', {
    id: row.id,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    totalMinutes: row.totalMinutes,
    peerPubkeys: row.peerPubkeys,
  })
}
