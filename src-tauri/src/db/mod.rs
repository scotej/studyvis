use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use rusqlite::Connection;
use tauri::{AppHandle, Manager, Runtime};

pub mod audit_events;
pub mod friends;
pub mod migrations;
pub mod sessions;

pub struct DbPool(pub Arc<Mutex<Connection>>);

const DB_FILE: &str = "app.db";

pub fn data_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let base = app
        .path()
        .data_dir()
        .map_err(|e| format!("data_dir: {e}"))?;
    let dir = base.join("studyvis");
    fs::create_dir_all(&dir).map_err(|e| format!("create_dir_all: {e}"))?;
    Ok(dir)
}

pub fn init<R: Runtime>(app: &AppHandle<R>) -> Result<DbPool, String> {
    let path = data_dir(app)?.join(DB_FILE);
    let mut conn = Connection::open(&path).map_err(|e| format!("open {}: {e}", path.display()))?;
    // Without a busy timeout SQLite returns SQLITE_BUSY immediately on a
    // contended write. run_migrations' BEGIN IMMEDIATE relies on blocking to
    // serialize a concurrent first-launch (there's no single-instance plugin);
    // it also hardens every normal write against a transient lock (OS backup /
    // AV briefly touching the file).
    conn.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|e| format!("busy_timeout: {e}"))?;
    migrations::run_migrations(&mut conn).map_err(|e| format!("migrations: {e}"))?;
    Ok(DbPool(Arc::new(Mutex::new(conn))))
}
