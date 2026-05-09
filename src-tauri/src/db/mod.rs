use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use rusqlite::Connection;
use tauri::{AppHandle, Manager};

pub mod friends;
pub mod migrations;
pub mod sessions;

pub struct DbPool(pub Arc<Mutex<Connection>>);

const DB_FILE: &str = "app.db";

pub fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .data_dir()
        .map_err(|e| format!("data_dir: {e}"))?;
    let dir = base.join("studyvis");
    fs::create_dir_all(&dir).map_err(|e| format!("create_dir_all: {e}"))?;
    Ok(dir)
}

pub fn init(app: &AppHandle) -> Result<DbPool, String> {
    let path = data_dir(app)?.join(DB_FILE);
    let mut conn = Connection::open(&path).map_err(|e| format!("open {}: {e}", path.display()))?;
    migrations::run_migrations(&mut conn).map_err(|e| format!("migrations: {e}"))?;
    Ok(DbPool(Arc::new(Mutex::new(conn))))
}
