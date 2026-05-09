use tauri::State;

use crate::db::{sessions, DbPool};

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
) -> Result<(), String> {
    let conn = lock(&state)?;
    let row = sessions::SessionRow {
        id,
        started_at,
        ended_at,
        total_minutes,
    };
    sessions::insert(&conn, &row).map_err(|e| e.to_string())
}
