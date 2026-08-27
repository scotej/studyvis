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

use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};

use serde::Serialize;
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
static JOURNAL_LOCK: Mutex<()> = Mutex::new(());

fn journal_guard() -> MutexGuard<'static, ()> {
    JOURNAL_LOCK.lock().unwrap_or_else(|e| e.into_inner())
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

#[tauri::command]
pub fn session_journal_append<R: Runtime>(
    app: AppHandle<R>,
    session_id: String,
    lines: Vec<String>,
) -> Result<(), String> {
    if lines.is_empty() {
        return Ok(());
    }
    if lines.len() > MAX_LINES_PER_CALL {
        return Err(format!(
            "too many journal lines in one call ({} > {MAX_LINES_PER_CALL})",
            lines.len()
        ));
    }
    let path = journal_path(&app, &session_id)?;
    let mut payload = String::new();
    for line in &lines {
        // A newline inside a "line" would split one observation into two
        // records the reader cannot parse. The writer never produces one
        // (JSON.stringify escapes them); refuse rather than corrupt the file.
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

    let _guard = journal_guard();
    let existing = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    if existing >= MAX_JOURNAL_BYTES {
        // Full. The session keeps running and the report is written from what
        // was recorded; silently dropping beats failing the sample loop's
        // fire-and-forget append for the rest of the session.
        return Ok(());
    }
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("open journal {}: {e}", path.display()))?;
    file.write_all(payload.as_bytes())
        .map_err(|e| format!("write journal {}: {e}", path.display()))
}

#[tauri::command]
pub fn session_journal_read<R: Runtime>(
    app: AppHandle<R>,
    session_id: String,
) -> Result<SessionJournal, String> {
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
}

/// Best-effort unlink for one session's journal, called after the session's
/// rows are deleted. A journal that outlived its session row would be evidence
/// for a report the user asked us to forget.
pub fn remove_journal<R: Runtime>(app: &AppHandle<R>, session_id: &str) {
    let Ok(path) = journal_path(app, session_id) else {
        return;
    };
    let _guard = journal_guard();
    let _ = fs::remove_file(path);
}

/// Best-effort removal of every journal, called by `sessions_clear_all`.
pub fn clear_journals<R: Runtime>(app: &AppHandle<R>) {
    let Ok(dir) = journal_dir(app) else {
        return;
    };
    let _guard = journal_guard();
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) == Some("ndjson") {
            let _ = fs::remove_file(path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
