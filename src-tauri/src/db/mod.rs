use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{Connection, OpenFlags};
use tauri::{AppHandle, Manager, Runtime};

pub mod audit_events;
pub mod friends;
pub mod migrations;
pub mod sessions;

pub struct DbPool(pub Arc<Mutex<Connection>>);

pub struct DbInit {
    pub pool: DbPool,
    /// File name the corrupt database was renamed to when recovery ran;
    /// `None` on a clean open. lib.rs surfaces it in the one-time dialog.
    pub recovered_from: Option<String>,
}

pub enum DbInitError {
    /// The schema on disk is newer than this binary understands (D6). The
    /// data is fine and must be left untouched — the app is too old.
    NewerVersion(String),
    Unrecoverable(String),
}

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

pub fn init<R: Runtime>(app: &AppHandle<R>) -> Result<DbInit, DbInitError> {
    let path = data_dir(app)
        .map_err(DbInitError::Unrecoverable)?
        .join(DB_FILE);
    let first_failure = match open_and_migrate(&path) {
        Ok(pool) => {
            return Ok(DbInit {
                pool,
                recovered_from: None,
            })
        }
        Err(OpenError::NewerSchema(detail)) => return Err(DbInitError::NewerVersion(detail)),
        Err(OpenError::Other(detail)) => detail,
    };

    // Only recreate when `integrity_check` DEFINITIVELY reports corruption.
    // A healthy-but-locked DB (SQLITE_BUSY) or one we can't open read-only
    // proves nothing about corruption — and renaming it would split-brain a
    // double-launch that slipped past the best-effort single-instance guard.
    // So treat anything short of an explicit non-"ok" verdict as environmental
    // (disk full, transient lock) and bail, preserving the file.
    if !is_definitely_corrupt(&path) {
        return Err(DbInitError::Unrecoverable(first_failure));
    }

    let unix_ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let corrupt_name = format!("{DB_FILE}.corrupt-{unix_ts}");
    fs::rename(&path, path.with_file_name(&corrupt_name)).map_err(|e| {
        DbInitError::Unrecoverable(format!(
            "{first_failure}; rename to {corrupt_name} failed: {e}"
        ))
    })?;

    match open_and_migrate(&path) {
        Ok(pool) => Ok(DbInit {
            pool,
            recovered_from: Some(corrupt_name),
        }),
        Err(OpenError::NewerSchema(detail)) | Err(OpenError::Other(detail)) => Err(
            DbInitError::Unrecoverable(format!("recreate after {first_failure}: {detail}")),
        ),
    }
}

enum OpenError {
    NewerSchema(String),
    Other(String),
}

fn open_and_migrate(path: &Path) -> Result<DbPool, OpenError> {
    let mut conn = Connection::open(path)
        .map_err(|e| OpenError::Other(format!("open {}: {e}", path.display())))?;
    // Without a busy timeout SQLite returns SQLITE_BUSY immediately on a
    // contended write. run_migrations' BEGIN IMMEDIATE relies on blocking to
    // serialize a concurrent first-launch (the single-instance guard is
    // best-effort); it also hardens every normal write against a transient
    // lock (OS backup / AV briefly touching the file).
    conn.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|e| OpenError::Other(format!("busy_timeout: {e}")))?;
    match migrations::run_migrations(&mut conn) {
        Ok(_) => Ok(DbPool(Arc::new(Mutex::new(conn)))),
        Err(e @ migrations::MigrationError::NewerSchema { .. }) => {
            Err(OpenError::NewerSchema(e.to_string()))
        }
        Err(e) => Err(OpenError::Other(format!("migrations: {e}"))),
    }
}

// True ONLY when `integrity_check` runs and returns a verdict that is NOT
// "ok" — i.e. the file is genuinely structurally corrupt. A failure to open
// read-only or a query error (e.g. SQLITE_BUSY from a concurrent holder)
// returns false: we couldn't prove corruption, so the caller must preserve the
// file rather than rename-and-recreate over still-good data.
fn is_definitely_corrupt(path: &Path) -> bool {
    let Ok(conn) = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY) else {
        return false;
    };
    // Block briefly on a contended lock so a healthy-but-busy DB doesn't read
    // as a failed PRAGMA (which would otherwise leave corruption unproven).
    if conn
        .busy_timeout(std::time::Duration::from_secs(5))
        .is_err()
    {
        return false;
    }
    match conn.query_row("PRAGMA integrity_check", [], |row| row.get::<_, String>(0)) {
        Ok(verdict) => verdict != "ok",
        // Couldn't run the check (lock, I/O error): corruption is unproven.
        Err(_) => false,
    }
}
