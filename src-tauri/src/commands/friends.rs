use tauri::State;

use crate::db::{friends, DbPool};

fn lock<'a>(
    state: &'a State<'_, DbPool>,
) -> Result<std::sync::MutexGuard<'a, rusqlite::Connection>, String> {
    state.0.lock().map_err(|e| format!("db poisoned: {e}"))
}

// These commands hold a `std::sync::MutexGuard` for their entire body. Keeping
// them sync (no `async`) means a future caller cannot accidentally `.await`
// across the lock and produce a deadlock. Tauri runs sync commands on its IPC
// thread pool, which matches the rusqlite blocking call shape.
#[tauri::command]
pub fn friends_list(state: State<'_, DbPool>) -> Result<Vec<friends::Friend>, String> {
    let conn = lock(&state)?;
    friends::list(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn friends_add(
    state: State<'_, DbPool>,
    ed_pubkey: String,
    x_pubkey: String,
    name: String,
    ts: i64,
) -> Result<(), String> {
    let conn = lock(&state)?;
    friends::add(&conn, &ed_pubkey, &x_pubkey, &name, ts).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn friends_remove(state: State<'_, DbPool>, ed_pubkey: String) -> Result<(), String> {
    let conn = lock(&state)?;
    friends::remove(&conn, &ed_pubkey).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn friends_update_last_studied(
    state: State<'_, DbPool>,
    ed_pubkey: String,
    ts: i64,
) -> Result<(), String> {
    let conn = lock(&state)?;
    friends::update_last_studied(&conn, &ed_pubkey, ts).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn friends_get_x_pubkey(
    state: State<'_, DbPool>,
    ed_pubkey: String,
) -> Result<Option<String>, String> {
    let conn = lock(&state)?;
    friends::get_x_pubkey(&conn, &ed_pubkey).map_err(|e| e.to_string())
}
