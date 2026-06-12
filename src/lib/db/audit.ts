import { invoke } from '@tauri-apps/api/core'

// `sessions_*` / `audit_events_*` return serde's serialized AuditEventRow,
// which uses Rust's snake_case field names verbatim — so this type mirrors
// them in snake_case, same as SessionRecord (see src/lib/db/sessions.ts).
// Only the JS→Rust *invoke arguments* are auto-camelCased by Tauri, which is
// why auditEventInsert passes `sessionId` while the row carries `session_id`.
export type AuditEventRecord = {
  session_id: string
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
    sessionId: row.session_id,
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

// R7 — every audit event across all sessions, for the cross-session focus
// insights view. Ordered by session then ts on the Rust side.
export async function auditEventsListAll(): Promise<AuditEventRecord[]> {
  return invoke<AuditEventRecord[]>('audit_events_list_all')
}
