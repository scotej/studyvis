//! Tauri command modules — the entire IPC surface callable from JS.
//!
//! Every command must also be listed in `generate_handler!` in `lib.rs`, under
//! a matching `#[cfg]`. The gates here are load-bearing: `identity` needs the
//! platform-specific `keyring` backend (including Secret Service on Linux),
//! and the `desktop` modules use tray/shortcut/window APIs absent on mobile.
//! Getting a gate wrong silently drops a whole command group at compile time.

pub mod friends;
mod worker;
use worker::blocking;
// #236 — the raw observation journal is a plain file beside the database, so
// it needs no platform backend and stays ungated like `sessions` itself.
pub mod session_journal;
pub mod sessions;

#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
pub mod identity;

#[cfg(desktop)]
pub mod ai_dialog;

// #317 — native preparation for the JS-created in-session overlay window.
#[cfg(desktop)]
pub mod session_overlay;

#[cfg(desktop)]
pub mod applog;

#[cfg(desktop)]
pub mod compute_device;

#[cfg(desktop)]
pub mod diagnostics;

#[cfg(desktop)]
pub mod engine;

// Only the macOS physical-key watcher in `system` publishes a level; gating the
// module to its single consumer keeps it off the Windows/Linux legs entirely.
#[cfg(target_os = "macos")]
mod level_confirmation;

// Platform-neutral on purpose, unlike `level_confirmation`: every desktop leg
// records session and shortcut lifecycle, so its tests run on all three.
#[cfg(desktop)]
pub mod native_log;

#[cfg(desktop)]
pub mod models;

#[cfg(desktop)]
pub mod mirror;

#[cfg(desktop)]
pub mod sidecar;

#[cfg(desktop)]
pub mod system;

#[cfg(test)]
mod tests {
    use super::blocking;
    use crate::db::{migrations, sessions, DbPool};
    use rusqlite::Connection;
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn sqlite_busy_wait_and_mutex_waiters_leave_async_timers_responsive() {
        let path = std::env::temp_dir().join(format!(
            "studyvis-command-busy-{}-{}.db",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let mut conn = Connection::open(&path).unwrap();
        migrations::run_migrations(&mut conn).unwrap();
        conn.busy_timeout(Duration::from_secs(5)).unwrap();
        let state = DbPool(Arc::new(Mutex::new(conn)));
        let exclusive = Connection::open(&path).unwrap();
        exclusive.execute_batch("BEGIN EXCLUSIVE").unwrap();
        let holder = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(800));
            exclusive.execute_batch("ROLLBACK").unwrap();
        });

        let mut requests = tokio::task::JoinSet::new();
        let (started_tx, mut started_rx) = tokio::sync::mpsc::channel(4);
        for _ in 0..4 {
            let state = DbPool(state.0.clone());
            let started_tx = started_tx.clone();
            requests.spawn(async move {
                blocking(move || {
                    let conn = state.0.lock().map_err(|error| error.to_string())?;
                    let _ = started_tx.try_send(());
                    sessions::get(&conn, "absent").map_err(|error| error.to_string())
                })
                .await
            });
        }
        let began = Instant::now();
        started_rx.recv().await.unwrap();
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(
            began.elapsed() < Duration::from_millis(500),
            "SQLite or synchronous mutex wait starved the async timer: {:?}",
            began.elapsed()
        );
        assert!(
            state.0.try_lock().is_err(),
            "a command must still own the busy database"
        );
        while let Some(result) = requests.join_next().await {
            assert!(result.unwrap().unwrap().is_none());
        }
        holder.join().unwrap();
        drop(state);
        std::fs::remove_file(path).unwrap();
    }

    #[tokio::test]
    async fn blocking_worker_preserves_operation_errors() {
        let error = blocking(|| Err::<(), _>("sqlite busy".to_string()))
            .await
            .unwrap_err();
        assert_eq!(error, "sqlite busy");
    }
}
