//! Raw per-session AI observation journal (#236).
//!
//! Every resolved focus check appends one NDJSON line describing what the
//! model said it saw. After the session ends, the frontend reads the file back
//! and asks the same local model to turn it into the written timeline stored in
//! `session_timelines`. The raw file stays on disk afterwards as the evidence
//! behind that narrative — it is what `source: 'observations'` renders directly
//! when no model output could be used.
//!
//! Deliberately dumb, like `applog`: the frontend renders and bounds each line,
//! this appends it. Its own directory rather than `logs/` so the diagnostics
//! archive (which sweeps named log files) is unaffected, and its own file per
//! session so deleting one session's history unlinks exactly one path.
//!
//! No image ever reaches this file. The lines carry the model's own text
//! judgment for a check — the same reasoning already persisted in the audit log
//! for warnings and alerts — plus the declared topic and a timestamp.

use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex, MutexGuard};

use serde::Serialize;
use tauri::ipc::{CommandArg, CommandItem, Invoke, InvokeError};
use tauri::{AppHandle, Runtime};

use crate::db::data_dir;

const JOURNAL_DIR: &str = "session-journals";

// Per-call ceilings, mirroring `applog`: the JS side already batches and
// clamps, and these bound what ONE IPC call can write.
const MAX_LINES_PER_CALL: usize = 64;
const MAX_LINE_BYTES: usize = 4 * 1024;

// A whole session's journal. A three-hour session at the fastest sustainable
// cadence writes on the order of 2000 lines, so this is far above any real
// session; past it, appends are dropped and the timeline is written from what
// was recorded rather than the file growing without bound.
const MAX_JOURNAL_BYTES: u64 = 2 * 1024 * 1024;
// Ceiling on one read. `truncated` tells the caller the narrative covers only
// the lines it received.
const MAX_READ_LINES: usize = 20_000;

// Both the session's own append path and a report regenerating a narrative can
// touch a journal at once. Without this, two appends can interleave a partial
// line.
// #404: IPC receipts capture a generation before async dispatch. Deleting a topic
// retires its older writes; clear-all retires every older write. New live
// samples remain valid even without a sessions row (saved only on leave).
static REMOVED_JOURNALS: LazyLock<Mutex<HashMap<PathBuf, u64>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static JOURNAL_GENERATION: AtomicU64 = AtomicU64::new(0);
static CLEAR_GENERATION: AtomicU64 = AtomicU64::new(0);

#[cfg(test)]
pub(crate) static TEST_LOCK: Mutex<()> = Mutex::new(());

fn journal_guard() -> MutexGuard<'static, HashMap<PathBuf, u64>> {
    REMOVED_JOURNALS.lock().unwrap_or_else(|e| e.into_inner())
}

/// Session ids are session topics: 32-byte SHA-256 digests as hex
/// (ARCHITECTURE.md §4). They become filenames here, so anything else is
/// refused rather than sanitized — a rejected append costs a narrative, while a
/// traversal would cost a file outside the data directory.
fn journal_file_name(session_id: &str) -> Result<String, String> {
    if session_id.is_empty() || session_id.len() > 64 {
        return Err("session id is not a session topic".to_string());
    }
    if !session_id.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("session id is not a session topic".to_string());
    }
    Ok(format!("{}.ndjson", session_id.to_ascii_lowercase()))
}

fn journal_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let dir = data_dir(app)?.join(JOURNAL_DIR);
    fs::create_dir_all(&dir).map_err(|e| format!("create journal dir: {e}"))?;
    Ok(dir)
}

fn journal_path<R: Runtime>(app: &AppHandle<R>, session_id: &str) -> Result<PathBuf, String> {
    let name = journal_file_name(session_id)?;
    Ok(journal_dir(app)?.join(name))
}

/// One session's raw observations, oldest first.
#[derive(Debug, Clone, Serialize)]
pub struct SessionJournal {
    pub lines: Vec<String>,
    /// The file held more than this read returned (either it hit the size cap
    /// while the session ran, or it has more lines than one read carries).
    pub truncated: bool,
}

// Tauri first calls async command bodies on a scheduled task, which can run
// after a later delete. Claim the append here, before that scheduling boundary.
pub fn with_append_receipts<R: Runtime>(
    handler: impl Fn(Invoke<R>) -> bool + Send + Sync + 'static,
) -> impl Fn(Invoke<R>) -> bool + Send + Sync + 'static {
    move |invoke| {
        if invoke.message.command() != "session_journal_append" {
            return handler(invoke);
        }
        let generation = JOURNAL_GENERATION.load(Ordering::Acquire);
        let Invoke {
            message,
            resolver,
            acl,
        } = invoke;
        resolver.respond_async(async move {
            let app: AppHandle<R> = CommandArg::from_command(CommandItem {
                plugin: None,
                name: "session_journal_append",
                key: "app",
                message: &message,
                acl: &acl,
            })?;
            let session_id: String = CommandArg::from_command(CommandItem {
                plugin: None,
                name: "session_journal_append",
                key: "sessionId",
                message: &message,
                acl: &acl,
            })?;
            let lines: Vec<String> = CommandArg::from_command(CommandItem {
                plugin: None,
                name: "session_journal_append",
                key: "lines",
                message: &message,
                acl: &acl,
            })?;
            append_claimed(app, session_id, lines, generation)
                .await
                .map_err(InvokeError::from)
        });
        true
    }
}

// Direct Rust callers use this entry; native IPC must use the receipt wrapper
// before Tauri schedules the command body.
#[tauri::command]
pub async fn session_journal_append<R: Runtime>(
    app: AppHandle<R>,
    session_id: String,
    lines: Vec<String>,
) -> Result<(), String> {
    let generation = JOURNAL_GENERATION.load(Ordering::Acquire);
    append_claimed(app, session_id, lines, generation).await
}

async fn append_claimed<R: Runtime>(
    app: AppHandle<R>,
    session_id: String,
    lines: Vec<String>,
    generation: u64,
) -> Result<(), String> {
    super::blocking(move || {
        if lines.is_empty() {
            return Ok(());
        }
        let path = journal_path(&app, &session_id)?;
        append_journal_at(&path, &lines, generation)
    })
    .await
}

fn append_journal_at(path: &Path, lines: &[String], generation: u64) -> Result<(), String> {
    if lines.len() > MAX_LINES_PER_CALL {
        return Err(format!(
            "too many journal lines in one call ({} > {MAX_LINES_PER_CALL})",
            lines.len()
        ));
    }
    let mut payload = String::new();
    for line in lines {
        if line.contains('\n') || line.contains('\r') {
            return Err("journal line contains a newline".to_string());
        }
        if line.len() > MAX_LINE_BYTES {
            return Err(format!(
                "journal line too long ({} > {MAX_LINE_BYTES})",
                line.len()
            ));
        }
        payload.push_str(line);
        payload.push('\n');
    }

    let removed = journal_guard();
    if removed
        .get(path)
        .is_some_and(|removed_at| generation < *removed_at)
        || generation < CLEAR_GENERATION.load(Ordering::Acquire)
    {
        return Ok(());
    }
    let existing = fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    if existing >= MAX_JOURNAL_BYTES {
        return Ok(());
    }
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|e| format!("open journal {}: {e}", path.display()))?;
    file.write_all(payload.as_bytes())
        .map_err(|e| format!("write journal {}: {e}", path.display()))
}

#[tauri::command]
pub async fn session_journal_read<R: Runtime>(
    app: AppHandle<R>,
    session_id: String,
) -> Result<SessionJournal, String> {
    super::blocking(move || {
        let path = journal_path(&app, &session_id)?;
        let _guard = journal_guard();
        let file = match File::open(&path) {
            Ok(file) => file,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                return Ok(SessionJournal {
                    lines: Vec::new(),
                    truncated: false,
                })
            }
            Err(err) => return Err(format!("open journal {}: {err}", path.display())),
        };
        let size = file.metadata().map(|m| m.len()).unwrap_or(0);
        let mut lines = Vec::new();
        let mut truncated = size >= MAX_JOURNAL_BYTES;
        for line in BufReader::new(file).lines() {
            let line = line.map_err(|e| format!("read journal {}: {e}", path.display()))?;
            if line.trim().is_empty() {
                continue;
            }
            if lines.len() >= MAX_READ_LINES {
                truncated = true;
                break;
            }
            lines.push(line);
        }
        Ok(SessionJournal { lines, truncated })
    })
    .await
}

fn unlink_if_present(path: &std::path::Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("remove observation journal: {error}")),
    }
}

fn remove_journal_at(path: &std::path::Path) -> Result<(), String> {
    let mut removed = journal_guard();
    let retired_at = JOURNAL_GENERATION.fetch_add(1, Ordering::AcqRel) + 1;
    removed.insert(path.to_owned(), retired_at);
    unlink_if_present(path)
}

fn remove_journal_in(dir: &std::path::Path, session_id: &str) -> Result<(), String> {
    remove_journal_at(&dir.join(journal_file_name(session_id)?))
}

fn clear_journals_in(dir: &std::path::Path) -> Result<(), String> {
    let _guard = journal_guard();
    let retired_at = JOURNAL_GENERATION.fetch_add(1, Ordering::AcqRel) + 1;
    CLEAR_GENERATION.store(retired_at, Ordering::Release);
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("read observation journal directory: {error}")),
    };
    let mut failed = 0;
    let mut first_error = None;
    for entry in entries {
        let result = match entry {
            Ok(entry) if entry.path().extension().and_then(|e| e.to_str()) == Some("ndjson") => {
                unlink_if_present(&entry.path())
            }
            Ok(_) => Ok(()),
            Err(error) => Err(format!("read observation journal entry: {error}")),
        };
        if let Err(error) = result {
            failed += 1;
            if first_error.is_none() {
                first_error = Some(error);
            }
        }
    }
    match first_error {
        Some(error) => Err(format!("{failed} journal cleanup failures: {error}")),
        None => Ok(()),
    }
}

// #405 / I100: SQL has already committed. Report cleanup failure and allow an
// idempotent retry even after its session row has gone; missing files are done.
pub fn remove_journal<R: Runtime>(app: &AppHandle<R>, session_id: &str) -> Result<(), String> {
    let dir = data_dir(app)?.join(JOURNAL_DIR);
    remove_journal_in(&dir, session_id)
}

pub fn clear_journals<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let dir = data_dir(app)?.join(JOURNAL_DIR);
    clear_journals_in(&dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "studyvis-journal-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn append_queued_before_delete_cannot_recreate_deleted_journal() {
        let _serial = TEST_LOCK.lock().unwrap();
        let dir = scratch_dir("delete-order");
        let path = dir.join("abcdef.ndjson");
        let generation = JOURNAL_GENERATION.load(Ordering::Acquire);
        append_journal_at(&path, &["before deletion".into()], generation).unwrap();
        let (release, queued) = std::sync::mpsc::channel();
        std::thread::scope(|scope| {
            let path = &path;
            let pending = scope.spawn(move || {
                queued.recv().unwrap();
                append_journal_at(path, &["queued observation".into()], generation).unwrap();
            });
            remove_journal_at(path).unwrap();
            assert!(!path.exists());
            release.send(()).unwrap();
            pending.join().unwrap();
        });
        assert!(
            !path.exists(),
            "completed deletion must retire queued appends"
        );
        let current = JOURNAL_GENERATION.load(Ordering::Acquire);
        append_journal_at(&path, &["new active sample".into()], current).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "new active sample\n");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn clear_all_discards_pending_samples_but_allows_new_live_samples_without_a_session_row() {
        let _serial = TEST_LOCK.lock().unwrap();
        let dir = scratch_dir("clear-order");
        let path = dir.join("abcdef.ndjson");
        let not_yet_created = dir.join("123456.ndjson");
        let generation = JOURNAL_GENERATION.load(Ordering::Acquire);
        append_journal_at(&path, &["before clear".into()], generation).unwrap();
        clear_journals_in(&dir).unwrap();
        append_journal_at(&path, &["pending".into()], generation).unwrap();
        append_journal_at(
            &not_yet_created,
            &["pending first sample".into()],
            generation,
        )
        .unwrap();
        assert!(!path.exists());
        assert!(!not_yet_created.exists());

        let current = JOURNAL_GENERATION.load(Ordering::Acquire);
        append_journal_at(&path, &["new live sample".into()], current).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "new live sample\n");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn deleting_one_topic_preserves_other_live_journals_without_saved_session_rows() {
        let _serial = TEST_LOCK.lock().unwrap();
        let dir = scratch_dir("live-session");
        let deleted = dir.join("abcdef.ndjson");
        let live = dir.join("123456.ndjson");
        let generation = JOURNAL_GENERATION.load(Ordering::Acquire);
        remove_journal_at(&deleted).unwrap();
        append_journal_at(&live, &["active observation".into()], generation).unwrap();
        assert_eq!(fs::read_to_string(&live).unwrap(), "active observation\n");
        assert!(!deleted.exists());
        fs::remove_dir_all(dir).unwrap();
    }

    fn cleanup_fixture(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "studyvis-journal-cleanup-{label}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn cleanup_missing_files_is_success_and_failed_unlink_can_be_retried() {
        let _serial = TEST_LOCK.lock().unwrap();
        let dir = cleanup_fixture("single");
        remove_journal_in(&dir, "ab").unwrap();
        let path = dir.join("ab.ndjson");
        fs::create_dir(&path).unwrap();
        assert!(remove_journal_in(&dir, "ab").is_err());
        fs::remove_dir(&path).unwrap();
        fs::write(&path, b"disposable observation").unwrap();
        remove_journal_in(&dir, "ab").unwrap();
        remove_journal_in(&dir, "ab").unwrap();
        assert!(!path.exists());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn clear_attempts_all_entries_and_reports_partial_cleanup_then_retries() {
        let _serial = TEST_LOCK.lock().unwrap();
        let dir = cleanup_fixture("all");
        fs::write(dir.join("ab.ndjson"), b"disposable observation").unwrap();
        fs::create_dir(dir.join("cd.ndjson")).unwrap();
        fs::write(dir.join("unrelated.txt"), b"leave alone").unwrap();
        assert!(clear_journals_in(&dir).is_err());
        assert!(!dir.join("ab.ndjson").exists());
        assert!(dir.join("cd.ndjson").exists());
        assert!(dir.join("unrelated.txt").exists());
        fs::remove_dir(dir.join("cd.ndjson")).unwrap();
        clear_journals_in(&dir).unwrap();
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn clear_distinguishes_missing_directory_from_unreadable_directory() {
        let _serial = TEST_LOCK.lock().unwrap();
        let dir = cleanup_fixture("read");
        clear_journals_in(&dir.join("missing")).unwrap();
        let file = dir.join("file");
        fs::write(&file, b"not a directory").unwrap();
        assert!(clear_journals_in(&file).is_err());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn failed_cleanup_retires_pending_appends_and_successful_retry_removes_evidence() {
        let _serial = TEST_LOCK.lock().unwrap();
        let dir = cleanup_fixture("retirement-retry");
        let path = dir.join("ab.ndjson");
        fs::create_dir(&path).unwrap();
        let generation = JOURNAL_GENERATION.load(Ordering::Acquire);
        assert!(remove_journal_in(&dir, "ab").is_err());
        fs::remove_dir(&path).unwrap();
        append_journal_at(&path, &["queued before failed cleanup".into()], generation).unwrap();
        assert!(!path.exists());
        fs::write(&path, b"evidence awaiting cleanup retry").unwrap();
        remove_journal_in(&dir, "ab").unwrap();
        remove_journal_in(&dir, "ab").unwrap();
        assert!(!path.exists());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn accepts_a_session_topic() {
        let name = journal_file_name(&"a".repeat(64)).expect("hex topic");
        assert_eq!(name, format!("{}.ndjson", "a".repeat(64)));
    }

    #[test]
    fn lowercases_so_one_session_owns_one_file() {
        assert_eq!(
            journal_file_name("ABCDEF").expect("hex"),
            "abcdef.ndjson".to_string()
        );
    }

    #[test]
    fn refuses_ids_that_are_not_session_topics() {
        for id in ["", "../escape", "a/b", "session one", "zz", &"a".repeat(65)] {
            assert!(
                journal_file_name(id).is_err(),
                "`{id}` must not become a journal filename"
            );
        }
    }
}
