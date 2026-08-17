//! Local diagnostics archive for issue #161.
//!
//! Every readable path is derived under StudyVis' data directory. The caller
//! supplies only the archive destination selected by the native save dialog.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Runtime};
use zip::write::SimpleFileOptions;

use super::applog::{app_log_guard, rotated_log_path, APP_LOG_FILE, LOG_HISTORY_FILES};
use super::sidecar::{sidecar_log_guard, SIDECAR_LOG_FILE};
use crate::db::data_dir;

const LOG_DIR: &str = "logs";
const TAIL_BYTES_PER_FILE: u64 = 1024 * 1024;
const TRUNCATION_MARKER: &str = "[older data truncated]\n";
const ARCHIVE_SCHEMA_VERSION: u32 = 1;
const README: &str = "StudyVis diagnostics\n\nThis archive was created locally and was not uploaded. It contains bounded tails of the StudyVis app log and the local AI engine (llama-server) log, including up to ten retained generations. StudyVis app records are redacted when written. AI-engine output is scrubbed for common home-directory usernames, but may still contain local model or machine details; review the files before sharing them.\n";

static EXPORT_LOCK: Mutex<()> = Mutex::new(());
static AUXILIARY_PATH_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Clone)]
struct DiagnosticsMetadata {
    app_version: String,
    os: String,
    arch: String,
    session_prefix: Option<String>,
}

#[derive(Serialize)]
struct Manifest {
    schema: u32,
    generated_unix_seconds: u64,
    studyvis_version: String,
    os: String,
    arch: String,
    session_prefix: Option<String>,
    retained_generations: usize,
    tail_bytes_per_file: u64,
    files: Vec<ManifestFile>,
}

#[derive(Serialize)]
struct ManifestFile {
    name: String,
    source_bytes: u64,
    included_bytes: usize,
    truncated: bool,
}

struct SnapshotFile {
    archive_name: String,
    contents: Vec<u8>,
    source_bytes: u64,
    truncated: bool,
}

fn log_sources(log_dir: &Path, filename: &str) -> Vec<(String, PathBuf)> {
    let live = log_dir.join(filename);
    let mut sources = vec![(filename.to_string(), live.clone())];
    for generation in 1..=LOG_HISTORY_FILES {
        sources.push((
            format!("{filename}.{generation}"),
            rotated_log_path(&live, generation),
        ));
    }
    sources
}

fn read_bounded_tail(path: &Path, archive_name: String) -> Result<SnapshotFile, String> {
    let mut file = File::open(path).map_err(|e| format!("open {}: {e}", path.display()))?;
    let source_bytes = file
        .metadata()
        .map_err(|e| format!("stat {}: {e}", path.display()))?
        .len();
    let from = source_bytes.saturating_sub(TAIL_BYTES_PER_FILE);
    file.seek(SeekFrom::Start(from))
        .map_err(|e| format!("seek {}: {e}", path.display()))?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|e| format!("read {}: {e}", path.display()))?;

    if from > 0 {
        if let Some(newline) = bytes.iter().position(|byte| *byte == b'\n') {
            bytes.drain(..=newline);
        } else {
            bytes.clear();
        }
    }

    let scrubbed = scrub_home_paths(&String::from_utf8_lossy(&bytes));
    let mut contents = Vec::with_capacity(scrubbed.len() + TRUNCATION_MARKER.len());
    if from > 0 {
        contents.extend_from_slice(TRUNCATION_MARKER.as_bytes());
    }
    contents.extend_from_slice(scrubbed.as_bytes());
    Ok(SnapshotFile {
        archive_name: format!("logs/{archive_name}"),
        contents,
        source_bytes,
        truncated: from > 0,
    })
}

fn snapshot_existing(log_dir: &Path, filename: &str) -> Result<Vec<SnapshotFile>, String> {
    log_sources(log_dir, filename)
        .into_iter()
        .filter(|(_, path)| path.is_file())
        .map(|(name, path)| read_bounded_tail(&path, name))
        .collect()
}

fn replace_home_segment(input: &str, prefix: &str, separator: char) -> String {
    let mut output = input.to_string();
    let mut search_from = 0;
    while let Some(relative) = output[search_from..].find(prefix) {
        let username_start = search_from + relative + prefix.len();
        let username_end = output[username_start..]
            .find(separator)
            .map(|offset| username_start + offset)
            .unwrap_or(output.len());
        if username_start == username_end {
            search_from = username_start;
            continue;
        }
        output.replace_range(username_start..username_end, "~");
        search_from = username_start + 1;
    }
    output
}

fn scrub_windows_homes(input: &str) -> String {
    let mut output = input.to_string();
    let mut search_from = 0;
    loop {
        let lowercase = output.to_ascii_lowercase();
        let Some(relative) = lowercase[search_from..].find(":\\users\\") else {
            break;
        };
        let username_start = search_from + relative + ":\\users\\".len();
        let username_end = output[username_start..]
            .find(['\\', '/'])
            .map(|offset| username_start + offset)
            .unwrap_or(output.len());
        if username_start == username_end {
            search_from = username_start;
            continue;
        }
        output.replace_range(username_start..username_end, "~");
        search_from = username_start + 1;
    }
    output
}

fn scrub_home_paths(input: &str) -> String {
    let mac = replace_home_segment(input, "/Users/", '/');
    let linux = replace_home_segment(&mac, "/home/", '/');
    scrub_windows_homes(&linux)
}

fn valid_session_prefix(value: Option<String>) -> Option<String> {
    value.filter(|prefix| {
        !prefix.is_empty()
            && prefix.len() <= 8
            && prefix.bytes().all(|byte| byte.is_ascii_hexdigit())
    })
}

fn destination_is_source(destination: &Path, log_dir: &Path) -> bool {
    let canonical_destination = destination.canonicalize().ok();
    [APP_LOG_FILE, SIDECAR_LOG_FILE]
        .into_iter()
        .flat_map(|filename| log_sources(log_dir, filename))
        .any(|(_, source)| {
            let same_canonical = match (&canonical_destination, source.canonicalize()) {
                (Some(destination), Ok(source)) => destination == &source,
                _ => false,
            };
            source == destination || same_canonical
        })
}

fn auxiliary_path(destination: &Path, label: &str) -> Result<PathBuf, String> {
    let parent = destination
        .parent()
        .ok_or_else(|| "diagnostics destination has no parent directory".to_string())?;
    let filename = destination
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "diagnostics destination has no valid filename".to_string())?;
    loop {
        let sequence = AUXILIARY_PATH_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let candidate = parent.join(format!(
            ".{filename}.studyvis-{}-{sequence}-{label}",
            std::process::id()
        ));
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
}

fn create_new_private_file(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}

fn install_new_destination(temp: &Path, destination: &Path) -> Result<(), String> {
    // `hard_link` is an atomic no-clobber install on filesystems that support
    // it. A removable/FAT destination may not; the create_new fallback keeps
    // the same no-overwrite guarantee while copying the completed temp file.
    if fs::hard_link(temp, destination).is_ok() {
        let _ = fs::remove_file(temp);
        return Ok(());
    }

    let mut source = File::open(temp).map_err(|e| format!("open diagnostics temp file: {e}"))?;
    let mut output = create_new_private_file(destination).map_err(|e| {
        format!(
            "create diagnostics destination {} without replacing an existing file: {e}",
            destination.display()
        )
    })?;
    let copied = io::copy(&mut source, &mut output)
        .and_then(|_| output.flush())
        .map_err(|e| format!("copy completed diagnostics archive: {e}"));
    if let Err(error) = copied {
        drop(output);
        let _ = fs::remove_file(destination);
        return Err(error);
    }
    drop(output);
    let _ = fs::remove_file(temp);
    Ok(())
}

fn write_archive(
    destination: &Path,
    metadata: DiagnosticsMetadata,
    snapshots: Vec<SnapshotFile>,
) -> Result<(), String> {
    let temp = auxiliary_path(destination, "building")?;
    let result = (|| -> Result<(), String> {
        let file = create_new_private_file(&temp)
            .map_err(|e| format!("create diagnostics archive {}: {e}", temp.display()))?;
        let mut zip = zip::ZipWriter::new(file);
        let options = SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated)
            .unix_permissions(0o600);

        let manifest_files = snapshots
            .iter()
            .map(|snapshot| ManifestFile {
                name: snapshot.archive_name.clone(),
                source_bytes: snapshot.source_bytes,
                included_bytes: snapshot.contents.len(),
                truncated: snapshot.truncated,
            })
            .collect();
        let manifest = Manifest {
            schema: ARCHIVE_SCHEMA_VERSION,
            generated_unix_seconds: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs(),
            studyvis_version: metadata.app_version,
            os: metadata.os,
            arch: metadata.arch,
            session_prefix: metadata.session_prefix,
            retained_generations: LOG_HISTORY_FILES,
            tail_bytes_per_file: TAIL_BYTES_PER_FILE,
            files: manifest_files,
        };

        zip.start_file("README.txt", options)
            .map_err(|e| format!("start README entry: {e}"))?;
        zip.write_all(README.as_bytes())
            .map_err(|e| format!("write README entry: {e}"))?;
        zip.start_file("manifest.json", options)
            .map_err(|e| format!("start manifest entry: {e}"))?;
        zip.write_all(
            serde_json::to_string_pretty(&manifest)
                .map_err(|e| format!("serialize diagnostics manifest: {e}"))?
                .as_bytes(),
        )
        .map_err(|e| format!("write manifest entry: {e}"))?;

        for snapshot in snapshots {
            zip.start_file(snapshot.archive_name, options)
                .map_err(|e| format!("start log entry: {e}"))?;
            zip.write_all(&snapshot.contents)
                .map_err(|e| format!("write log entry: {e}"))?;
        }
        zip.finish()
            .map_err(|e| format!("finish diagnostics archive: {e}"))?;
        install_new_destination(&temp, destination)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

fn build_diagnostics_archive(
    log_dir: &Path,
    destination: &Path,
    metadata: DiagnosticsMetadata,
) -> Result<(), String> {
    let _export_guard = EXPORT_LOCK
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    fs::create_dir_all(log_dir).map_err(|e| format!("create log dir: {e}"))?;
    if destination.is_dir() {
        return Err("diagnostics destination must be a file".to_string());
    }
    if destination_is_source(destination, log_dir) {
        return Err("diagnostics destination cannot replace a source log".to_string());
    }

    let mut snapshots = {
        let _guard = app_log_guard();
        snapshot_existing(log_dir, APP_LOG_FILE)?
    };
    snapshots.extend({
        let _guard = sidecar_log_guard();
        snapshot_existing(log_dir, SIDECAR_LOG_FILE)?
    });
    write_archive(destination, metadata, snapshots)
}

#[tauri::command]
pub async fn diagnostics_export<R: Runtime>(
    app: AppHandle<R>,
    path: String,
    session_prefix: Option<String>,
) -> Result<String, String> {
    let log_dir = data_dir(&app)?.join(LOG_DIR);
    let destination = PathBuf::from(path);
    let returned_path = destination.to_string_lossy().into_owned();
    let metadata = DiagnosticsMetadata {
        app_version: app.package_info().version.to_string(),
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        session_prefix: valid_session_prefix(session_prefix),
    };
    tauri::async_runtime::spawn_blocking(move || {
        build_diagnostics_archive(&log_dir, &destination, metadata)
    })
    .await
    .map_err(|e| format!("diagnostics export task: {e}"))??;
    Ok(returned_path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "studyvis-diagnostics-test-{name}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn metadata() -> DiagnosticsMetadata {
        DiagnosticsMetadata {
            app_version: "1.9.0".to_string(),
            os: "test-os".to_string(),
            arch: "test-arch".to_string(),
            session_prefix: Some("deadbeef".to_string()),
        }
    }

    #[test]
    fn archive_contains_fixed_log_names_and_manifest() {
        let root = scratch_dir("entries");
        let logs = root.join("logs");
        fs::create_dir_all(&logs).unwrap();
        fs::write(logs.join(APP_LOG_FILE), b"app-current\n").unwrap();
        fs::write(logs.join("studyvis.log.1"), b"app-old\n").unwrap();
        fs::write(logs.join(SIDECAR_LOG_FILE), b"ai-current\n").unwrap();
        let destination = root.join("diagnostics.zip");

        build_diagnostics_archive(&logs, &destination, metadata()).unwrap();

        let mut archive = zip::ZipArchive::new(File::open(destination).unwrap()).unwrap();
        let names: Vec<String> = archive.file_names().map(str::to_string).collect();
        assert_eq!(
            names,
            vec![
                "README.txt",
                "manifest.json",
                "logs/studyvis.log",
                "logs/studyvis.log.1",
                "logs/llama-server.log"
            ]
        );
        let mut manifest = String::new();
        archive
            .by_name("manifest.json")
            .unwrap()
            .read_to_string(&mut manifest)
            .unwrap();
        assert!(manifest.contains("deadbeef"));
        assert!(!manifest.contains(root.to_string_lossy().as_ref()));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn bounded_tail_marks_truncation_and_keeps_the_newest_complete_line() {
        let root = scratch_dir("tail");
        let path = root.join(APP_LOG_FILE);
        let mut contents = vec![b'x'; TAIL_BYTES_PER_FILE as usize + 32];
        contents.extend_from_slice(b"\nnewest-line\n");
        fs::write(&path, contents).unwrap();

        let snapshot = read_bounded_tail(&path, APP_LOG_FILE.to_string()).unwrap();
        let text = String::from_utf8(snapshot.contents).unwrap();
        assert!(text.starts_with(TRUNCATION_MARKER));
        assert!(text.ends_with("newest-line\n"));
        assert!(snapshot.truncated);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn invalid_utf8_is_lossy_and_home_paths_are_scrubbed() {
        let root = scratch_dir("scrub");
        let path = root.join(SIDECAR_LOG_FILE);
        fs::write(
            &path,
            b"/Users/John Smith/models/a.gguf /home/scott/models/b.gguf C:\\Users\\Jane Doe\\m.gguf \xff\n",
        )
        .unwrap();
        let snapshot = read_bounded_tail(&path, SIDECAR_LOG_FILE.to_string()).unwrap();
        let text = String::from_utf8(snapshot.contents).unwrap();
        assert!(text.contains("/Users/~/models/a.gguf"));
        assert!(text.contains("/home/~/models/b.gguf"));
        assert!(text.contains("C:\\Users\\~\\m.gguf"));
        assert!(!text.contains("John Smith"));
        assert!(!text.contains("scott"));
        assert!(!text.contains("Jane Doe"));
        assert!(text.contains('\u{fffd}'));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn missing_logs_still_produce_a_manifest_only_archive() {
        let root = scratch_dir("missing");
        let logs = root.join("logs");
        let destination = root.join("diagnostics.zip");
        build_diagnostics_archive(&logs, &destination, metadata()).unwrap();
        let archive = zip::ZipArchive::new(File::open(destination).unwrap()).unwrap();
        assert_eq!(archive.len(), 2);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn refuses_to_replace_a_source_log_or_its_alias() {
        let root = scratch_dir("source-destination");
        let logs = root.join("logs");
        fs::create_dir_all(&logs).unwrap();
        let source = logs.join(APP_LOG_FILE);
        fs::write(&source, b"keep me").unwrap();

        let direct_error = build_diagnostics_archive(&logs, &source, metadata()).unwrap_err();
        assert!(direct_error.contains("cannot replace"));
        let alias = logs.join("..").join("logs").join(APP_LOG_FILE);
        let alias_error = build_diagnostics_archive(&logs, &alias, metadata()).unwrap_err();
        assert!(alias_error.contains("cannot replace"));
        assert_eq!(fs::read(&source).unwrap(), b"keep me");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn refuses_to_overwrite_an_existing_archive() {
        let root = scratch_dir("existing-destination");
        let logs = root.join("logs");
        fs::create_dir_all(&logs).unwrap();
        fs::write(logs.join(APP_LOG_FILE), b"new-log\n").unwrap();
        let destination = root.join("diagnostics.zip");
        fs::write(&destination, b"previous archive").unwrap();

        let error = build_diagnostics_archive(&logs, &destination, metadata()).unwrap_err();

        assert!(error.contains("without replacing"));
        assert_eq!(fs::read(&destination).unwrap(), b"previous archive");
        assert!(!root
            .read_dir()
            .unwrap()
            .flatten()
            .any(|entry| entry.file_name().to_string_lossy().contains("studyvis-")));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn session_prefix_accepts_only_short_hex_values() {
        assert_eq!(
            valid_session_prefix(Some("deadBEEF".to_string())).as_deref(),
            Some("deadBEEF")
        );
        assert_eq!(valid_session_prefix(Some("not-hex".to_string())), None);
        assert_eq!(valid_session_prefix(Some("deadbeef0".to_string())), None);
    }
}
