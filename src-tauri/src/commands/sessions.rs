//! Session + audit-event commands: thin sync wrappers over `db::sessions` and
//! `db::audit_events` (same held-guard, no-async locking pattern as
//! `commands/friends.rs`). Upsert/cascade semantics live in the `db` layer;
//! the TS callers are `src/lib/db/sessions.ts` and `src/lib/db/audit.ts`
//! (camelCase invoke args in, snake_case serde rows out).

use tauri::{AppHandle, Runtime, State};

use crate::commands::session_journal;
use crate::db::{audit_events, session_timelines, sessions, DbPool};

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
    total_minutes: Option<i64>,
    total_duration_ms: Option<i64>,
    peer_pubkeys: Option<String>,
    peer_presence_ms: Option<String>,
    declared_topic: Option<String>,
    score: Option<i64>,
    focused_pct: Option<f64>,
    generated_at: Option<i64>,
    confident_samples: Option<i64>,
    skipped_samples: Option<i64>,
    // I83 — 1 = AI focus detection was on for this session, 0 = off, None =
    // caller didn't say (older frontend). None coalesces, so an omitted value
    // never overwrites a recorded one.
    ai_enabled: Option<i64>,
    local_ed_pubkey: Option<String>,
    local_display_name: Option<String>,
    // A focus score is stateful. If a same-topic stint began without its
    // predecessor's in-memory state, the frontend passes true so an honest
    // null can clear the stale score instead of COALESCE retaining it.
    replace_focus_metrics: Option<bool>,
) -> Result<(), String> {
    let conn = lock(&state)?;
    let row = sessions::SessionRow {
        id,
        started_at: Some(started_at),
        ended_at: Some(ended_at),
        total_minutes,
        total_duration_ms,
        peer_pubkeys,
        declared_topic,
        score,
        focused_pct,
        generated_at,
        confident_samples,
        skipped_samples,
        ai_enabled,
        local_ed_pubkey,
        local_display_name,
        peer_presence_ms,
    };
    sessions::insert_with_focus_metrics_mode(&conn, &row, replace_focus_metrics.unwrap_or(false))
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn sessions_insert_if_absent(
    state: State<'_, DbPool>,
    id: String,
    started_at: i64,
    ended_at: i64,
    total_minutes: Option<i64>,
    total_duration_ms: Option<i64>,
    peer_pubkeys: Option<String>,
    peer_presence_ms: Option<String>,
    declared_topic: Option<String>,
    score: Option<i64>,
    focused_pct: Option<f64>,
    generated_at: Option<i64>,
    confident_samples: Option<i64>,
    skipped_samples: Option<i64>,
    ai_enabled: Option<i64>,
    local_ed_pubkey: Option<String>,
    local_display_name: Option<String>,
) -> Result<bool, String> {
    let conn = lock(&state)?;
    let row = sessions::SessionRow {
        id,
        started_at: Some(started_at),
        ended_at: Some(ended_at),
        total_minutes,
        total_duration_ms,
        peer_pubkeys,
        declared_topic,
        score,
        focused_pct,
        generated_at,
        confident_samples,
        skipped_samples,
        ai_enabled,
        local_ed_pubkey,
        local_display_name,
        peer_presence_ms,
    };
    sessions::insert_if_absent(&conn, &row).map_err(|e| e.to_string())
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

// R4 + #236 — the SQL cascade drops the session, its audit events, and its
// written timeline in one transaction; the raw observation journal is a file,
// so it is unlinked after that transaction commits. Deleting rows first means a
// failure can only ever leave an orphaned journal (which the next regeneration
// or clear-all removes), never a narrative whose evidence is already gone.
#[tauri::command]
pub fn sessions_delete<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, DbPool>,
    id: String,
) -> Result<(), String> {
    {
        let mut conn = lock(&state)?;
        sessions::delete(&mut conn, &id).map_err(|e| e.to_string())?;
    }
    session_journal::remove_journal(&app, &id);
    Ok(())
}

#[tauri::command]
pub fn sessions_clear_all<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, DbPool>,
) -> Result<(), String> {
    {
        let mut conn = lock(&state)?;
        sessions::clear_all(&mut conn).map_err(|e| e.to_string())?;
    }
    session_journal::clear_journals(&app);
    Ok(())
}

// #236 — the post-session written timeline. `entries` is the JSON array the
// frontend validated before persisting; this layer stores it verbatim, the same
// way audit-event detail is stored.
#[tauri::command]
pub fn session_timeline_get(
    state: State<'_, DbPool>,
    session_id: String,
) -> Result<Option<session_timelines::SessionTimelineRow>, String> {
    let conn = lock(&state)?;
    session_timelines::get(&conn, &session_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn session_timeline_save(
    state: State<'_, DbPool>,
    session_id: String,
    generated_at: i64,
    model_id: Option<String>,
    source: String,
    entries: String,
    truncated: bool,
) -> Result<(), String> {
    let conn = lock(&state)?;
    let row = session_timelines::SessionTimelineRow {
        session_id,
        generated_at,
        model_id,
        source,
        entries,
        truncated: i64::from(truncated),
    };
    session_timelines::upsert(&conn, &row).map_err(|e| e.to_string())
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
