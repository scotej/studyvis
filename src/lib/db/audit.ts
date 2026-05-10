import { invoke } from '@tauri-apps/api/core'

export type AuditEventRecord = {
  sessionId: string
  ts: number
  who: string
  kind: string
  // JSON-serialized detail object. Audit-event detail is constrained to
  // JSON-safe values on the wire (see src/features/session/audit.ts).
  detail: string
  sig: string
}

export async function auditEventInsert(row: AuditEventRecord): Promise<void> {
  await invoke('audit_event_insert', {
    sessionId: row.sessionId,
    ts: row.ts,
    who: row.who,
    kind: row.kind,
    detail: row.detail,
    sig: row.sig,
  })
}

export async function auditEventsListForSession(
  sessionId: string
): Promise<AuditEventRecord[]> {
  return invoke<AuditEventRecord[]>('audit_events_list_for_session', {
    sessionId,
  })
}
