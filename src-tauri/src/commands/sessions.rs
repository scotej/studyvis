use tauri::State;

use crate::db::{audit_events, sessions, DbPool};

fn lock<'a>(
    state: &'a State<'_, DbPool>,
) -> Result<std::sync::MutexGuard<'a, rusqlite::Connection>, String> {
    state.0.lock().map_err(|e| format!("db poisoned: {e}"))
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn sessions_insert(
    state: State<'_, DbPool>,
    id: String,
    started_at: i64,
    ended_at: i64,
    total_minutes: i64,
    peer_pubkeys: Option<String>,
    declared_topic: Option<String>,
    score: Option<i64>,
    focused_pct: Option<f64>,
    generated_at: Option<i64>,
) -> Result<(), String> {
    let conn = lock(&state)?;
    let row = sessions::SessionRow {
        id,
        started_at: Some(started_at),
        ended_at: Some(ended_at),
        total_minutes: Some(total_minutes),
        peer_pubkeys,
        declared_topic,
        score,
        focused_pct,
        generated_at,
    };
    sessions::insert(&conn, &row).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn sessions_list(state: State<'_, DbPool>) -> Result<Vec<sessions::SessionRow>, String> {
    let conn = lock(&state)?;
    sessions::list(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn sessions_get(
    state: State<'_, DbPool>,
    id: String,
) -> Result<Option<sessions::SessionRow>, String> {
    let conn = lock(&state)?;
    sessions::get(&conn, &id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn audit_event_insert(
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

#[tauri::command]
pub fn audit_events_list_for_session(
    state: State<'_, DbPool>,
    session_id: String,
) -> Result<Vec<audit_events::AuditEventRow>, String> {
    let conn = lock(&state)?;
    audit_events::list_for_session(&conn, &session_id).map_err(|e| e.to_string())
}
