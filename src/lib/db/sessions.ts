import { invoke } from '@tauri-apps/api/core'

export type SessionRow = {
  id: string
  startedAt: number
  endedAt: number
  totalMinutes: number
}

export async function sessionsInsert(row: SessionRow): Promise<void> {
  await invoke('sessions_insert', {
    id: row.id,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    totalMinutes: row.totalMinutes,
  })
}
