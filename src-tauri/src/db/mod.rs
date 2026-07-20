//! Local SQLite bootstrap: open `app.db` under `path::data_dir()/studyvis/`,
//! run forward-only migrations, and recover from proven corruption.
//!
//! All persistence goes through here — the frontend never opens a DB handle;
//! it calls the thin command wrappers in `commands/{friends,sessions}.rs`,
//! which query via the submodules below. The data directory is `studyvis`
//! under the OS data dir (NOT the `com.studyvis.app` bundle identifier — that
//! names the keychain service and a *different* Tauri `app_data_dir` used for
//! `settings.json`).
//!
//! Failure policy on open: `NewerVersion` (schema from a future build) shows a
//! blocking "update needed" dialog and exits, leaving the file untouched; only
//! DEFINITIVE corruption (see `is_definitely_corrupt`) sets the file aside as
//! `app.db.corrupt-<ts>` and recreates. A merely locked/busy DB is preserved.

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

/// The app's single shared connection behind a `Mutex` (not an actual pool),
/// managed as Tauri state in `lib.rs`. Commands lock it synchronously for
/// their whole body — keep command fns non-async so a caller can never hold
/// the guard across an `.await`.
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

// Best-effort adoption of audit_events whose session died with the app
// (crash / power-loss / force-kill) before the leave handler could write a
// sessions row — see sessions::synthesize_from_orphaned_audit_events. The
// local pubkey (to exclude self from peer_pubkeys) comes from a minimal
// identity.json read; either being unavailable degrades to synthesis with
// all who-values kept or to skipping, never to a failed boot.
fn adopt_orphaned_sessions<R: Runtime>(app: &AppHandle<R>, pool: &DbPool) {
    let local_ed = local_ed_pubkey(app);
    let Ok(mut conn) = pool.0.lock() else {
        return;
    };
    match sessions::synthesize_from_orphaned_audit_events(&mut conn, local_ed.as_deref()) {
        Ok(0) => {}
        Ok(n) => eprintln!("db: adopted {n} crash-orphaned session(s) from audit events"),
        Err(e) => eprintln!("db: orphaned-session synthesis failed (continuing): {e}"),
    }
}

fn local_ed_pubkey<R: Runtime>(app: &AppHandle<R>) -> Option<String> {
    let path = data_dir(app).ok()?.join("identity.json");
    let raw = fs::read_to_string(path).ok()?;
    let value: serde_json::Value = serde_json::from_str(&raw).ok()?;
    Some(value.get("ed_pubkey_hex")?.as_str()?.to_owned())
}

pub fn init<R: Runtime>(app: &AppHandle<R>) -> Result<DbInit, DbInitError> {
    let path = data_dir(app)
        .map_err(DbInitError::Unrecoverable)?
        .join(DB_FILE);
    let first_failure = match open_and_migrate(&path) {
        Ok(pool) => {
            adopt_orphaned_sessions(app, &pool);
            return Ok(DbInit {
                pool,
                recovered_from: None,
            });
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
    // Remove the rollback-journal / WAL sidecars of the corrupt DB. Left in
    // place next to a freshly-created app.db they'd be mis-associated with the
    // new file and could corrupt it in turn (SQLite would try to apply a stale
    // WAL to a fresh DB). A missing sidecar is the normal case, but a sidecar we
    // CAN'T delete (permission / lock / I/O) must abort recovery — recreating
    // app.db over a live sidecar is exactly the corruption we're avoiding.
    for sidecar in ["-journal", "-wal", "-shm"] {
        let sidecar_path = path.with_file_name(format!("{DB_FILE}{sidecar}"));
        match fs::remove_file(&sidecar_path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => {
                return Err(DbInitError::Unrecoverable(format!(
                    "{first_failure}; renamed to {corrupt_name}, but couldn't remove {}: {e}",
                    sidecar_path.display()
                )));
            }
        }
    }

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

// True when the file is provably structurally corrupt. Two signals count:
//   1. `integrity_check` runs and returns a verdict that is NOT "ok".
//   2. `integrity_check` ITSELF errors with a corruption error code — this is
//      the common real-world case: a file truncated by a power-loss/force-kill
//      mid-write surfaces `SQLITE_CORRUPT`, and a damaged/garbage header
//      surfaces `SQLITE_NOTADB`. Treating those Errs as "unproven" (the old
//      behavior) meant recovery never fired for exactly the corruption it was
//      built for, permanently bricking startup.
// A failure to open read-only or an ambiguous error (SQLITE_BUSY from a
// concurrent holder, an I/O fault) returns false: corruption is unproven, so
// the caller preserves the file rather than rename-and-recreate over good data.
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
        Err(e) => is_corruption_error(&e),
    }
}

// Whether a rusqlite error's SQLite result code proves on-disk corruption
// (as opposed to an environmental fault like a lock or transient I/O error we
// must not destroy the file over).
fn is_corruption_error(e: &rusqlite::Error) -> bool {
    matches!(
        e,
        rusqlite::Error::SqliteFailure(err, _)
            if err.code == rusqlite::ErrorCode::DatabaseCorrupt
                || err.code == rusqlite::ErrorCode::NotADatabase
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn temp_path(name: &str) -> PathBuf {
        let mut dir = std::env::temp_dir();
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        dir.push(format!("studyvis-dbtest-{unique}-{name}"));
        dir
    }

    // A real (small) SQLite DB whose file is then truncated mid-body surfaces
    // SQLITE_CORRUPT from integrity_check — must classify as corrupt so
    // recovery fires instead of the app bricking on every launch.
    #[test]
    fn truncated_db_is_definitely_corrupt() {
        let path = temp_path("truncated.db");
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(
                "PRAGMA page_size=4096; CREATE TABLE t(a TEXT); \
                 INSERT INTO t(a) VALUES ('x'),('y'),('z');",
            )
            .unwrap();
        }
        let full = fs::read(&path).unwrap();
        assert!(full.len() > 4096, "expected a multi-page db");
        // Keep the header + first page but lop off the rest of the body.
        let f = fs::OpenOptions::new().write(true).open(&path).unwrap();
        f.set_len(4096 + 100).unwrap();
        drop(f);
        assert!(is_definitely_corrupt(&path));
        let _ = fs::remove_file(&path);
    }

    // A file with a garbage (non-SQLite) header surfaces SQLITE_NOTADB.
    #[test]
    fn bad_magic_header_is_definitely_corrupt() {
        let path = temp_path("badmagic.db");
        {
            let mut f = fs::File::create(&path).unwrap();
            f.write_all(&[0xDE; 8192]).unwrap();
        }
        assert!(is_definitely_corrupt(&path));
        let _ = fs::remove_file(&path);
    }

    // A healthy DB must NOT be classified as corrupt (never destroy good data).
    #[test]
    fn healthy_db_is_not_corrupt() {
        let path = temp_path("healthy.db");
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch("CREATE TABLE t(a TEXT); INSERT INTO t(a) VALUES ('ok');")
                .unwrap();
        }
        assert!(!is_definitely_corrupt(&path));
        let _ = fs::remove_file(&path);
    }

    // An absent / unopenable file is unproven, not corrupt.
    #[test]
    fn missing_file_is_not_definitely_corrupt() {
        let path = temp_path("missing.db");
        assert!(!is_definitely_corrupt(&path));
    }
}
