//! On-disk sink for the frontend's structured log (`src/lib/log.ts`, #98).
//!
//! Deliberately dumb: JS renders and redacts each NDJSON line, this appends it
//! and rolls the file. Its own file, never `llama-server.log` — `sidecar_start`
//! holds that one open for the sidecar's whole lifetime, and its roll is
//! documented as safe only because no writer is open at the moment it happens.

use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use tauri::{AppHandle, Runtime};

use crate::db::data_dir;

const LOG_DIR: &str = "logs";
pub(crate) const APP_LOG_FILE: &str = "studyvis.log";
pub(crate) const LOG_HISTORY_FILES: usize = 10;

// The structured app log rolls at 2 MiB. Ten retained generations bound its
// history at roughly 20 MiB while still leaving enough room for several long
// sessions. The diagnostics archive applies a separate, smaller tail cap.
const APP_LOG_MAX_BYTES: u64 = 2 * 1024 * 1024;

// Per-call ceilings. The JS logger already batches and clamps; these bound what
// ONE IPC call can write. The app-command ACL grants this command to the main
// window and the AI dialog only, and never gives the dialog path control.
const MAX_LINES_PER_CALL: usize = 256;
const MAX_LINE_BYTES: usize = 8 * 1024;

const TAIL_READ_BYTES: u64 = 256 * 1024;
const MAX_TAIL_LINES: usize = 500;

// Both webviews call `app_log_append`. Without this, two appends can interleave
// a partial line and a roll can race a write.
static APP_LOG_LOCK: Mutex<()> = Mutex::new(());

pub(crate) fn app_log_guard() -> MutexGuard<'static, ()> {
    APP_LOG_LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

pub(crate) fn app_log_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let dir = data_dir(app)?.join(LOG_DIR);
    fs::create_dir_all(&dir).map_err(|e| format!("create log dir: {e}"))?;
    Ok(dir.join(APP_LOG_FILE))
}

fn open_append(path: &Path) -> Result<File, String> {
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|e| format!("open app log {}: {e}", path.display()))
}

fn should_rotate(current_len: u64, max_bytes: u64) -> bool {
    current_len >= max_bytes
}

pub(crate) fn rotated_log_path(path: &Path, generation: usize) -> PathBuf {
    path.with_extension(format!("log.{generation}"))
}

// Shift oldest-to-newest destinations in descending order. Removing each
// destination first is load-bearing on Windows: unlike Unix, `fs::rename`
// does not replace an existing file there.
pub(crate) fn shift_log_history(path: &Path, generations: usize) {
    if generations == 0 {
        return;
    }
    let oldest = rotated_log_path(path, generations);
    let _ = fs::remove_file(&oldest);
    for generation in (1..generations).rev() {
        let source = rotated_log_path(path, generation);
        if !source.is_file() {
            continue;
        }
        let destination = rotated_log_path(path, generation + 1);
        let _ = fs::remove_file(&destination);
        let _ = fs::rename(source, destination);
    }
}

pub(crate) fn rotate_log_history(path: &Path, generations: usize) {
    if generations == 0 || !path.is_file() {
        return;
    }
    shift_log_history(path, generations);
    let first = rotated_log_path(path, 1);
    let _ = fs::remove_file(&first);
    let _ = fs::rename(path, first);
}

// Size-bounded roll. Best-effort: a failed metadata read or rename must never
// turn logging into an error the app has to handle.
fn rotate_if_needed(path: &Path, max_bytes: u64) {
    let Ok(meta) = fs::metadata(path) else {
        return;
    };
    if !should_rotate(meta.len(), max_bytes) {
        return;
    }
    rotate_log_history(path, LOG_HISTORY_FILES);
}

// One record is one line, so an embedded newline would split a record in two
// and a reader would see a forged one. JS strips control characters already;
// this is the second half of the same guarantee, on the side that owns the
// file format.
fn clamp_line(line: &str) -> String {
    let mut clamped = line.replace(['\n', '\r'], " ");
    if clamped.len() > MAX_LINE_BYTES {
        let mut cut = MAX_LINE_BYTES;
        while cut > 0 && !clamped.is_char_boundary(cut) {
            cut -= 1;
        }
        clamped.truncate(cut);
    }
    clamped
}

fn render_batch(lines: &[String]) -> String {
    let mut out = String::new();
    for line in lines.iter().take(MAX_LINES_PER_CALL) {
        out.push_str(&clamp_line(line));
        out.push('\n');
    }
    out
}

/// Append pre-rendered NDJSON records to `<data_dir>/logs/studyvis.log`.
///
/// Payload only — the path is derived here and never taken from the caller.
/// `system_write_text_file`'s caller-supplied-path shape is deliberately not
/// the precedent: this command is one of the two custom commands the AI-dialog
/// capability may invoke, so its narrow payload prevents that secondary
/// webview from choosing a filesystem target.
#[tauri::command]
pub fn app_log_append<R: Runtime>(app: AppHandle<R>, lines: Vec<String>) -> Result<(), String> {
    if lines.is_empty() {
        return Ok(());
    }
    let path = app_log_path(&app)?;
    append_rendered_lines(&path, &lines)
}

/// The shared write path for both producers: the JS sink through
/// `app_log_append`, and `native_log` writing Rust records into the same file
/// (#226). Every existing guarantee holds for both because they share this
/// function — `APP_LOG_LOCK` serialises them, the roll happens inside the guard
/// while this call holds the only writer, and the `File` is dropped here rather
/// than cached (on Windows `fs::rename` fails against an open handle).
pub(crate) fn append_rendered_lines(path: &Path, lines: &[String]) -> Result<(), String> {
    if lines.is_empty() {
        return Ok(());
    }
    let body = render_batch(lines);
    let _guard = app_log_guard();
    rotate_if_needed(path, APP_LOG_MAX_BYTES);
    let mut file = open_append(path)?;
    file.write_all(body.as_bytes())
        .map_err(|e| format!("append app log: {e}"))
}

/// The last `max_lines` records, for Settings → Advanced → Copy diagnostics.
/// Reads only the live generation: a file that just rolled yields a short tail,
/// which is the honest answer rather than a stitched-together one.
#[tauri::command]
pub fn app_log_tail<R: Runtime>(
    app: AppHandle<R>,
    max_lines: usize,
) -> Result<Vec<String>, String> {
    let path = app_log_path(&app)?;
    let _guard = app_log_guard();
    let Ok(mut file) = File::open(&path) else {
        return Ok(Vec::new());
    };
    let len = file
        .metadata()
        .map_err(|e| format!("stat app log: {e}"))?
        .len();
    let from = len.saturating_sub(TAIL_READ_BYTES);
    file.seek(SeekFrom::Start(from))
        .map_err(|e| format!("seek app log: {e}"))?;
    let mut buf = Vec::new();
    file.read_to_end(&mut buf)
        .map_err(|e| format!("read app log: {e}"))?;
    let text = String::from_utf8_lossy(&buf);
    let mut lines: Vec<&str> = text.lines().collect();
    // A mid-file seek lands inside a line; drop that fragment.
    if from > 0 && !lines.is_empty() {
        lines.remove(0);
    }
    let want = max_lines.min(MAX_TAIL_LINES);
    let start = lines.len().saturating_sub(want);
    Ok(lines[start..].iter().map(|s| (*s).to_string()).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "studyvis-applog-test-{name}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn rotates_at_or_above_cap() {
        assert!(should_rotate(APP_LOG_MAX_BYTES, APP_LOG_MAX_BYTES));
        assert!(should_rotate(APP_LOG_MAX_BYTES + 1, APP_LOG_MAX_BYTES));
    }

    #[test]
    fn keeps_small_log() {
        assert!(!should_rotate(0, APP_LOG_MAX_BYTES));
        assert!(!should_rotate(APP_LOG_MAX_BYTES - 1, APP_LOG_MAX_BYTES));
    }

    #[test]
    fn strips_embedded_newlines_so_one_record_is_one_line() {
        assert_eq!(clamp_line("{\"a\":\"b\r\nc\"}"), "{\"a\":\"b  c\"}");
    }

    #[test]
    fn clamps_an_oversized_line_on_a_char_boundary() {
        let mut line = "x".repeat(MAX_LINE_BYTES - 1);
        line.push('é');
        let clamped = clamp_line(&line);
        assert!(clamped.len() <= MAX_LINE_BYTES);
        assert_eq!(clamped.len(), MAX_LINE_BYTES - 1);
    }

    #[test]
    fn renders_one_newline_terminated_line_per_record() {
        let batch = render_batch(&["a".to_string(), "b".to_string()]);
        assert_eq!(batch, "a\nb\n");
    }

    #[test]
    fn truncates_an_oversized_batch() {
        let lines: Vec<String> = (0..MAX_LINES_PER_CALL + 10)
            .map(|i| i.to_string())
            .collect();
        assert_eq!(render_batch(&lines).lines().count(), MAX_LINES_PER_CALL);
    }

    #[test]
    fn appends_then_rolls_into_history() {
        let dir = scratch_dir("roll");
        let path = dir.join(APP_LOG_FILE);

        let mut file = open_append(&path).unwrap();
        file.write_all(render_batch(&["first".to_string()]).as_bytes())
            .unwrap();
        drop(file);
        assert_eq!(fs::read_to_string(&path).unwrap(), "first\n");

        // Under the cap nothing moves.
        rotate_if_needed(&path, APP_LOG_MAX_BYTES);
        assert!(!path.with_extension("log.1").exists());

        // At the cap the live file becomes the newest rolled generation and a
        // fresh live file starts empty.
        rotate_if_needed(&path, 1);
        assert!(!path.exists());
        assert_eq!(
            fs::read_to_string(path.with_extension("log.1")).unwrap(),
            "first\n"
        );

        let mut file = open_append(&path).unwrap();
        file.write_all(render_batch(&["second".to_string()]).as_bytes())
            .unwrap();
        drop(file);
        assert_eq!(fs::read_to_string(&path).unwrap(), "second\n");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rotation_shifts_ten_generations_and_drops_the_oldest() {
        let dir = scratch_dir("history");
        let path = dir.join(APP_LOG_FILE);
        fs::write(&path, "live").unwrap();
        for generation in 1..=LOG_HISTORY_FILES {
            fs::write(
                rotated_log_path(&path, generation),
                format!("old-{generation}"),
            )
            .unwrap();
        }

        rotate_log_history(&path, LOG_HISTORY_FILES);

        assert!(!path.exists());
        assert_eq!(
            fs::read_to_string(rotated_log_path(&path, 1)).unwrap(),
            "live"
        );
        for generation in 2..=LOG_HISTORY_FILES {
            assert_eq!(
                fs::read_to_string(rotated_log_path(&path, generation)).unwrap(),
                format!("old-{}", generation - 1)
            );
        }
        assert!(!rotated_log_path(&path, LOG_HISTORY_FILES + 1).exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rotation_handles_gaps_without_duplicating_history() {
        let dir = scratch_dir("gaps");
        let path = dir.join(APP_LOG_FILE);
        fs::write(&path, "live").unwrap();
        fs::write(rotated_log_path(&path, 2), "old-2").unwrap();

        rotate_log_history(&path, LOG_HISTORY_FILES);

        assert_eq!(
            fs::read_to_string(rotated_log_path(&path, 1)).unwrap(),
            "live"
        );
        assert!(!rotated_log_path(&path, 2).exists());
        assert_eq!(
            fs::read_to_string(rotated_log_path(&path, 3)).unwrap(),
            "old-2"
        );
        let _ = fs::remove_dir_all(&dir);
    }
}
