use tauri::State;

use crate::db::{audit_events, sessions, DbPool};

fn lock<'a>(
    state: &'a State<'_, DbPool>,
) -> Result<std::sync::MutexGuard<'a, rusqlite::Connection>, String> {
    state.0.lock().map_err(|e| format!("db poisoned: {e}"))
}

#[tauri::command]
pub async fn sessions_insert(
    state: State<'_, DbPool>,
    id: String,
    started_at: i64,
    ended_at: i64,
    total_minutes: i64,
    peer_pubkeys: Option<String>,
) -> Result<(), String> {
    let conn = lock(&state)?;
    // V1 callers (lifecycle.ts) always pass concrete values; the SessionRow
    // struct uses Option<i64> only so SELECT paths tolerate NULL rows that
    // future migrations or partial inserts might leave behind.
    let row = sessions::SessionRow {
        id,
        started_at: Some(started_at),
        ended_at: Some(ended_at),
        total_minutes: Some(total_minutes),
        peer_pubkeys,
    };
    sessions::insert(&conn, &row).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn sessions_list(state: State<'_, DbPool>) -> Result<Vec<sessions::SessionRow>, String> {
    let conn = lock(&state)?;
    sessions::list(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn audit_event_insert(
    state: State<'_, DbPool>,
    session_id: String,
    ts: i64,
    who: String,
    kind: String,
    detail: String,
    sig: String,
) -> Result<(), String> {
    let conn = lock(&state)?;
    let row = audit_events::AuditEventRow {
        session_id,
        ts,
        who,
        kind,
        detail,
        sig,
    };
    audit_events::insert(&conn, &row).map_err(|e| e.to_string())
}
