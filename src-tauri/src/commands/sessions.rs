//! Session + audit-event commands: thin sync wrappers over `db::sessions` and
//! `db::audit_events` (same held-guard, no-async locking pattern as
//! `commands/friends.rs`). Upsert/cascade semantics live in the `db` layer;
//! the TS callers are `src/lib/db/sessions.ts` and `src/lib/db/audit.ts`
//! (camelCase invoke args in, snake_case serde rows out).

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
    confident_samples: Option<i64>,
    skipped_samples: Option<i64>,
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
        confident_samples,
        skipped_samples,
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
pub fn sessions_delete(state: State<'_, DbPool>, id: String) -> Result<(), String> {
    let mut conn = lock(&state)?;
    sessions::delete(&mut conn, &id).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn sessions_clear_all(state: State<'_, DbPool>) -> Result<(), String> {
    let mut conn = lock(&state)?;
    sessions::clear_all(&mut conn).map_err(|e| e.to_string())?;
    Ok(())
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

// R7 — cross-session audit events for the local focus-insights view. The
// frontend shapes them in the pure statsInsights seam; this command only
// reads.
#[tauri::command]
pub fn audit_events_list_all(
    state: State<'_, DbPool>,
) -> Result<Vec<audit_events::AuditEventRow>, String> {
    let conn = lock(&state)?;
    audit_events::list_ai_distractions_all(&conn).map_err(|e| e.to_string())
}
