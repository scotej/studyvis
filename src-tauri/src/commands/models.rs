//! GGUF model-file management on disk under `<data>/studyvis/models/<id>/`:
//! resumable downloads from Hugging Face, install-state checks, removal, and
//! keychain custody of the optional HF token (gated-model tier).
//!
//! Notes for editors:
//! - `validate_model_id` is a path-traversal guard — every path-building fn
//!   funnels through it because the JS-supplied id becomes a directory name.
//! - Downloads stream sequentially with SHA-256 verification, resume from a
//!   kept `.tmp` via HTTP Range, and rename atomically on success; per-model
//!   cancellation rides an `AtomicBool` in `DownloadState`.
//! - Install state lives on the FILESYSTEM (and `models.json` on the JS
//!   side), not in SQLite — the `models` table from migration 002 is a
//!   currently-unused placeholder.

use std::collections::HashMap;
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::async_runtime::Mutex;
use tauri::{AppHandle, Emitter, Runtime, State};

#[cfg(any(target_os = "macos", target_os = "windows"))]
use keyring::Entry;

use crate::db::data_dir;

const MODELS_DIR: &str = "models";
const MODEL_LOCAL_FILENAME: &str = "model.gguf";
const MMPROJ_LOCAL_FILENAME: &str = "mmproj.gguf";
const TMP_SUFFIX: &str = ".tmp";

// Throttle the volume of progress events. The download loop computes a
// cumulative byte count after each chunk; we only emit when at least
// PROGRESS_EVENT_BYTES have flowed since the last emit OR
// PROGRESS_EVENT_INTERVAL has elapsed. For multi-GB GGUFs this caps event
// traffic at ~1/sec while still feeling live in the UI.
const PROGRESS_EVENT_BYTES: u64 = 1024 * 1024;
const PROGRESS_EVENT_INTERVAL: Duration = Duration::from_millis(250);
// reqwest's `timeout()` is a TOTAL request timeout — applying it to streaming
// multi-GB GETs would reliably abort downloads on normal connections (5 GB at
// 10 MB/s ≈ 8 minutes). We use `connect_timeout` for the TCP/TLS handshake and
// `read_timeout` for the idle-between-reads bound, then rely on the per-chunk
// `AtomicBool` cancel flag + manual streaming loop for the rest. HEAD checks
// reuse the same client and are small enough that the absent total timeout
// doesn't matter.
const HTTP_CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
// Per-read idle timeout (reqwest 0.12.5+). A mid-stream network stall (laptop
// sleep, NAT rebind, silently dropped socket with no RST) otherwise blocks
// `bytes_stream().next()` forever: the cancel flag is only polled AFTER a chunk
// yields, so the download future never returns, the UI freezes, Cancel no-ops,
// and the model_id stays permanently locked (`download already in flight`).
// Bounding each read turns the stall into a normal stream error — the `.tmp`
// is kept for Range resume and the model_id is released.
const HTTP_READ_TIMEOUT: Duration = Duration::from_secs(60);

#[cfg(any(target_os = "macos", target_os = "windows"))]
const KEYRING_SERVICE: &str = "com.studyvis.app";
#[cfg(any(target_os = "macos", target_os = "windows"))]
const KEYRING_USER_HF_TOKEN: &str = "hf-access-token";

// Model-id sanitization. JS supplies an id from `models.ts`; we treat the
// filesystem path it lands at as untrusted and refuse anything that could
// escape the `<data>/studyvis/models/` directory.
fn validate_model_id(model_id: &str) -> Result<(), String> {
    if model_id.is_empty() || model_id.len() > 64 {
        return Err("model_id length must be 1..=64".into());
    }
    if !model_id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
    {
        return Err("model_id may only contain ASCII alphanumerics, '-', '_', '.'".into());
    }
    if model_id == "." || model_id == ".." || model_id.starts_with('.') {
        return Err("model_id may not start with '.'".into());
    }
    Ok(())
}

fn models_root<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let dir = data_dir(app)?.join(MODELS_DIR);
    fs::create_dir_all(&dir).map_err(|e| format!("create models dir: {e}"))?;
    Ok(dir)
}

fn model_dir<R: Runtime>(app: &AppHandle<R>, model_id: &str) -> Result<PathBuf, String> {
    validate_model_id(model_id)?;
    let dir = models_root(app)?.join(model_id);
    Ok(dir)
}

#[derive(Serialize)]
pub struct ModelPaths {
    pub dir: String,
    pub model_path: String,
    pub mmproj_path: String,
}

#[tauri::command]
pub fn model_paths<R: Runtime>(app: AppHandle<R>, model_id: String) -> Result<ModelPaths, String> {
    let dir = model_dir(&app, &model_id)?;
    Ok(ModelPaths {
        dir: dir.to_string_lossy().into_owned(),
        model_path: dir
            .join(MODEL_LOCAL_FILENAME)
            .to_string_lossy()
            .into_owned(),
        mmproj_path: dir
            .join(MMPROJ_LOCAL_FILENAME)
            .to_string_lossy()
            .into_owned(),
    })
}

#[derive(Serialize)]
pub struct ModelFileState {
    pub exists: bool,
    pub size: u64,
}

#[derive(Serialize)]
pub struct ModelInstallState {
    pub model: ModelFileState,
    pub mmproj: ModelFileState,
}

fn file_state(path: &Path) -> ModelFileState {
    match fs::metadata(path) {
        Ok(m) if m.is_file() => ModelFileState {
            exists: true,
            size: m.len(),
        },
        _ => ModelFileState {
            exists: false,
            size: 0,
        },
    }
}

#[tauri::command]
pub fn model_install_state<R: Runtime>(
    app: AppHandle<R>,
    model_id: String,
) -> Result<ModelInstallState, String> {
    let dir = model_dir(&app, &model_id)?;
    Ok(ModelInstallState {
        model: file_state(&dir.join(MODEL_LOCAL_FILENAME)),
        mmproj: file_state(&dir.join(MMPROJ_LOCAL_FILENAME)),
    })
}

// Removal must consult the sidecar: a running llama-server memory-maps the
// model it serves, so deleting the directory out from under it fails partway
// on Windows (sharing violation → broken partial install + raw OS error) and
// on macOS "succeeds" while the unlinked multi-GB file stays alive on disk
// and the sidecar keeps serving a model the UI says is gone. Sibling of the
// I25/I35 lifecycle-hygiene fixes.
#[tauri::command]
pub async fn model_remove<R: Runtime>(
    app: AppHandle<R>,
    sidecar: State<'_, crate::commands::sidecar::SidecarState>,
    model_id: String,
) -> Result<(), String> {
    let dir = model_dir(&app, &model_id)?;
    let stopped = crate::commands::sidecar::stop_if_serving_under(&sidecar, &dir).await?;
    if !dir.exists() {
        return Ok(());
    }
    tauri::async_runtime::spawn_blocking(move || {
        // On Windows, kill() (TerminateProcess) returns before the OS has
        // necessarily released the child's file mappings, so the first unlink
        // after a stop can still hit a sharing violation — retry briefly on
        // the just-stopped path instead of surfacing a raw OS error for a
        // transient state.
        let attempts = if stopped { 10 } else { 1 };
        let mut last: Option<std::io::Error> = None;
        for i in 0..attempts {
            match fs::remove_dir_all(&dir) {
                Ok(()) => return Ok(()),
                Err(e) => {
                    last = Some(e);
                    if i + 1 < attempts {
                        std::thread::sleep(Duration::from_millis(100));
                    }
                }
            }
        }
        Err(format!(
            "remove model dir: {}",
            last.expect("at least one attempt ran")
        ))
    })
    .await
    .map_err(|e| format!("remove model dir task: {e}"))?
}

#[derive(Serialize)]
pub struct HeadResult {
    pub status: u16,
    pub content_length: Option<u64>,
}

fn build_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(HTTP_CONNECT_TIMEOUT)
        .read_timeout(HTTP_READ_TIMEOUT)
        .user_agent(concat!(
            "studyvis/",
            env!("CARGO_PKG_VERSION"),
            " (peer-to-peer study app)"
        ))
        .build()
        .map_err(|e| format!("build http client: {e}"))
}

#[tauri::command]
pub async fn model_head_check(url: String, with_token: bool) -> Result<HeadResult, String> {
    let client = build_client()?;
    let mut req = client.head(&url);
    if with_token {
        if let Some(token) = load_hf_token_internal() {
            req = req.bearer_auth(token);
        }
    }
    let resp = req.send().await.map_err(|e| format!("HEAD {}: {e}", url))?;
    let status = resp.status();
    let content_length = resp.content_length();
    Ok(HeadResult {
        status: status.as_u16(),
        content_length,
    })
}

// ── Hugging Face access token (mac + win only — Linux deferred with V1-P3) ──

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn hf_token_entry() -> Result<Entry, String> {
    Entry::new(KEYRING_SERVICE, KEYRING_USER_HF_TOKEN).map_err(|e| e.to_string())
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
#[tauri::command]
pub fn hf_token_save(token: String) -> Result<(), String> {
    let trimmed = token.trim();
    if trimmed.is_empty() {
        return Err("token must not be empty".into());
    }
    if !trimmed.chars().all(|c| c.is_ascii_graphic()) {
        return Err("token must be ASCII printable (no whitespace or controls)".into());
    }
    hf_token_entry()?
        .set_password(trimmed)
        .map_err(|e| format!("keyring set: {e}"))
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
#[tauri::command]
pub fn hf_token_present() -> Result<bool, String> {
    match hf_token_entry()?.get_password() {
        Ok(s) => Ok(!s.is_empty()),
        Err(keyring::Error::NoEntry) => Ok(false),
        Err(e) => Err(format!("keyring get: {e}")),
    }
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
#[tauri::command]
pub fn hf_token_clear() -> Result<(), String> {
    match hf_token_entry()?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("keyring delete: {e}")),
    }
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn load_hf_token_internal() -> Option<String> {
    match Entry::new(KEYRING_SERVICE, KEYRING_USER_HF_TOKEN)
        .ok()?
        .get_password()
    {
        Ok(s) if !s.is_empty() => Some(s),
        _ => None,
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn load_hf_token_internal() -> Option<String> {
    None
}

// ── Downloads ───────────────────────────────────────────────────────────

#[derive(Default)]
pub struct DownloadInner {
    cancellations: HashMap<String, Arc<AtomicBool>>,
}

pub struct DownloadState(Arc<Mutex<DownloadInner>>);

impl DownloadState {
    pub fn new() -> Self {
        Self(Arc::new(Mutex::new(DownloadInner::default())))
    }
}

#[derive(Deserialize, Clone)]
pub struct ModelFileRequest {
    pub url: String,
    pub size_bytes: u64,
    pub sha256_hex: String,
    pub kind: ModelFileKind,
}

#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum ModelFileKind {
    Model,
    Mmproj,
}

impl ModelFileKind {
    fn local_filename(self) -> &'static str {
        match self {
            ModelFileKind::Model => MODEL_LOCAL_FILENAME,
            ModelFileKind::Mmproj => MMPROJ_LOCAL_FILENAME,
        }
    }

    fn label(self) -> &'static str {
        match self {
            ModelFileKind::Model => "model",
            ModelFileKind::Mmproj => "mmproj",
        }
    }
}

#[derive(Serialize, Clone)]
pub struct ProgressEvent {
    pub model_id: String,
    pub file: &'static str,
    pub file_index: usize,
    pub file_count: usize,
    pub bytes_received: u64,
    pub total_bytes: u64,
    pub phase: ProgressPhase,
    pub error: Option<String>,
}

#[derive(Serialize, Clone, Copy)]
#[serde(rename_all = "snake_case")]
pub enum ProgressPhase {
    Downloading,
    Verifying,
    Done,
    Failed,
    Cancelled,
}

const PROGRESS_EVENT_NAME: &str = "model:progress";

fn emit_progress<R: Runtime>(app: &AppHandle<R>, evt: &ProgressEvent) {
    let _ = app.emit(PROGRESS_EVENT_NAME, evt);
}

#[tauri::command]
pub async fn model_download<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, DownloadState>,
    model_id: String,
    files: Vec<ModelFileRequest>,
    use_token: bool,
) -> Result<(), String> {
    if files.is_empty() {
        return Err("files must not be empty".into());
    }
    validate_model_id(&model_id)?;
    let dir = model_dir(&app, &model_id)?;
    fs::create_dir_all(&dir).map_err(|e| format!("create model dir: {e}"))?;

    let cancel = Arc::new(AtomicBool::new(false));
    {
        let arc = state.0.clone();
        let mut guard = arc.lock().await;
        if guard.cancellations.contains_key(&model_id) {
            return Err(format!(
                "download already in flight for model_id={model_id}"
            ));
        }
        guard.cancellations.insert(model_id.clone(), cancel.clone());
    }

    let token = if use_token {
        load_hf_token_internal()
    } else {
        None
    };

    // Run the per-file downloads sequentially. We don't parallelize: HF's
    // CDN throttles per-connection and parallel HTTP/2 streams for the same
    // origin would just contend. Sequential keeps the progress UI simple.
    let outcome = run_download(&app, &dir, &model_id, &files, token, &cancel).await;

    {
        let arc = state.0.clone();
        let mut guard = arc.lock().await;
        guard.cancellations.remove(&model_id);
    }

    match outcome {
        Ok(()) => {
            emit_progress(
                &app,
                &ProgressEvent {
                    model_id,
                    file: "all",
                    file_index: files.len(),
                    file_count: files.len(),
                    bytes_received: 0,
                    total_bytes: 0,
                    phase: ProgressPhase::Done,
                    error: None,
                },
            );
            Ok(())
        }
        Err(DownloadError::Cancelled) => {
            // No cleanup on cancel: an in-flight file keeps its .tmp so a
            // later attempt Range-resumes it, and an earlier file's verified
            // target stays in place — the UI's install_state probe reports
            // the partial install and the user can re-download.
            emit_progress(
                &app,
                &ProgressEvent {
                    model_id,
                    file: "all",
                    file_index: 0,
                    file_count: files.len(),
                    bytes_received: 0,
                    total_bytes: 0,
                    phase: ProgressPhase::Cancelled,
                    error: None,
                },
            );
            Err("cancelled".into())
        }
        Err(DownloadError::Other(e)) => {
            emit_progress(
                &app,
                &ProgressEvent {
                    model_id,
                    file: "all",
                    file_index: 0,
                    file_count: files.len(),
                    bytes_received: 0,
                    total_bytes: 0,
                    phase: ProgressPhase::Failed,
                    error: Some(e.clone()),
                },
            );
            Err(e)
        }
    }
}

#[tauri::command]
pub async fn model_download_cancel(
    state: State<'_, DownloadState>,
    model_id: String,
) -> Result<(), String> {
    let arc = state.0.clone();
    let guard = arc.lock().await;
    if let Some(flag) = guard.cancellations.get(&model_id) {
        flag.store(true, Ordering::SeqCst);
    }
    Ok(())
}

enum DownloadError {
    Cancelled,
    Other(String),
}

async fn run_download<R: Runtime>(
    app: &AppHandle<R>,
    dir: &Path,
    model_id: &str,
    files: &[ModelFileRequest],
    token: Option<String>,
    cancel: &Arc<AtomicBool>,
) -> Result<(), DownloadError> {
    let client = build_client().map_err(DownloadError::Other)?;
    let file_count = files.len();
    for (file_index, file) in files.iter().enumerate() {
        if cancel.load(Ordering::SeqCst) {
            return Err(DownloadError::Cancelled);
        }
        let target = dir.join(file.kind.local_filename());
        // Fast-path: skip re-downloading a file that already matches the
        // expected size + sha256. Lets a partially-completed pair finish
        // without redoing the gigabyte that already landed.
        if target.exists() {
            if let Ok(meta) = fs::metadata(&target) {
                if meta.len() == file.size_bytes {
                    // Hashing a multi-GB GGUF is a synchronous, CPU+IO-bound
                    // loop. Offload to a blocking thread so it doesn't pin a
                    // Tauri async-runtime worker and stall concurrent IPC
                    // (same pattern as sidecar.rs's spawn_blocking).
                    let hash_target = target.clone();
                    let computed = tauri::async_runtime::spawn_blocking(move || {
                        hash_file_blocking(&hash_target)
                    })
                    .await
                    .map_err(|e| DownloadError::Other(e.to_string()))?
                    .map_err(DownloadError::Other)?;
                    if computed.eq_ignore_ascii_case(&file.sha256_hex) {
                        emit_progress(
                            app,
                            &ProgressEvent {
                                model_id: model_id.to_string(),
                                file: file.kind.label(),
                                file_index,
                                file_count,
                                bytes_received: meta.len(),
                                total_bytes: file.size_bytes,
                                phase: ProgressPhase::Done,
                                error: None,
                            },
                        );
                        continue;
                    }
                    // Existing file is the right size but wrong hash —
                    // remove and re-download below.
                    let _ = fs::remove_file(&target);
                }
            }
        }
        download_one(
            app,
            &client,
            model_id,
            file_index,
            file_count,
            file,
            token.as_deref(),
            &target,
            cancel,
        )
        .await?;
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn download_one<R: Runtime>(
    app: &AppHandle<R>,
    client: &reqwest::Client,
    model_id: &str,
    file_index: usize,
    file_count: usize,
    file: &ModelFileRequest,
    token: Option<&str>,
    target: &Path,
    cancel: &Arc<AtomicBool>,
) -> Result<(), DownloadError> {
    let tmp = target.with_extension(format!(
        "{}{}",
        target
            .extension()
            .map(|e| e.to_string_lossy().into_owned())
            .unwrap_or_default(),
        TMP_SUFFIX
    ));

    // A4 resume: a .tmp left by an interrupted run is kept and continued via
    // an HTTP Range request. The sha256 hasher is seeded with the bytes
    // already on disk so end-of-stream verification still covers the whole
    // file. A .tmp at or past the expected size can't be range-resumed (the
    // server would answer 416 Range Not Satisfiable) — start that one over.
    let mut hasher = Sha256::new();
    let mut resume_offset: u64 = 0;
    if let Ok(meta) = fs::metadata(&tmp) {
        if meta.is_file() {
            if file.size_bytes != 0 && meta.len() >= file.size_bytes {
                let _ = fs::remove_file(&tmp);
            } else if meta.len() > 0 {
                let seed_path = tmp.clone();
                let (seeded, hashed) =
                    tauri::async_runtime::spawn_blocking(move || seed_hasher_blocking(&seed_path))
                        .await
                        .map_err(|e| DownloadError::Other(e.to_string()))?
                        .map_err(DownloadError::Other)?;
                hasher = seeded;
                resume_offset = hashed;
            }
        }
    }

    let mut req = client.get(&file.url);
    if let Some(t) = token {
        req = req.bearer_auth(t);
    }
    if resume_offset > 0 {
        req = req.header(reqwest::header::RANGE, format!("bytes={resume_offset}-"));
    }
    let resp = req
        .send()
        .await
        .map_err(|e| DownloadError::Other(format!("GET {}: {e}", file.url)))?;
    if !resp.status().is_success() {
        let status = resp.status().as_u16();
        let hint = match status {
            401 => "; check your Hugging Face access token",
            403 => "; accept the model's terms on Hugging Face for the gated repo",
            404 => "; file not found in repo (manifest may be stale)",
            _ => "",
        };
        return Err(DownloadError::Other(format!(
            "{} returned HTTP {}{}",
            file.url, status, hint
        )));
    }
    // A 200 despite the Range header means the server is replaying the full
    // file — fall back to truncating and hashing from byte 0.
    let resumed = resume_offset > 0 && resp.status() == reqwest::StatusCode::PARTIAL_CONTENT;
    if !resumed && resume_offset > 0 {
        hasher = Sha256::new();
        resume_offset = 0;
    }
    // For a 206 the response's content_length is only the remaining range, so
    // the manifest size keeps the UI percentage denominator stable.
    let total = if resumed {
        if file.size_bytes != 0 {
            file.size_bytes
        } else {
            resume_offset + resp.content_length().unwrap_or(0)
        }
    } else {
        resp.content_length().unwrap_or(file.size_bytes)
    };

    let mut file_handle = if resumed {
        fs::OpenOptions::new().append(true).open(&tmp)
    } else {
        File::create(&tmp)
    }
    .map_err(|e| DownloadError::Other(format!("open {}: {e}", tmp.display())))?;
    let mut bytes_received: u64 = resume_offset;
    let mut last_event_bytes: u64 = resume_offset;
    let mut last_event_at = Instant::now();

    // Emit an immediate progress event so the UI sees the per-file phase
    // transition; bytes_received carries the resumed offset so the
    // percentage starts where the previous run left off.
    emit_progress(
        app,
        &ProgressEvent {
            model_id: model_id.to_string(),
            file: file.kind.label(),
            file_index,
            file_count,
            bytes_received,
            total_bytes: total,
            phase: ProgressPhase::Downloading,
            error: None,
        },
    );

    // Cancel / stream-error / write-error paths all KEEP the .tmp: the next
    // attempt resumes from its byte offset, which is exactly the
    // interrupted-download case Range resume exists for.
    let mut stream = resp.bytes_stream();
    while let Some(chunk_result) = stream.next().await {
        if cancel.load(Ordering::SeqCst) {
            return Err(DownloadError::Cancelled);
        }
        let chunk = match chunk_result {
            Ok(c) => c,
            Err(e) => {
                return Err(DownloadError::Other(format!("stream chunk: {e}")));
            }
        };
        hasher.update(&chunk);
        if let Err(e) = file_handle.write_all(&chunk) {
            return Err(DownloadError::Other(format!(
                "write {}: {e}",
                tmp.display()
            )));
        }
        bytes_received += chunk.len() as u64;

        let now = Instant::now();
        if bytes_received - last_event_bytes >= PROGRESS_EVENT_BYTES
            || now.duration_since(last_event_at) >= PROGRESS_EVENT_INTERVAL
        {
            emit_progress(
                app,
                &ProgressEvent {
                    model_id: model_id.to_string(),
                    file: file.kind.label(),
                    file_index,
                    file_count,
                    bytes_received,
                    total_bytes: total,
                    phase: ProgressPhase::Downloading,
                    error: None,
                },
            );
            last_event_bytes = bytes_received;
            last_event_at = now;
        }
    }

    if let Err(e) = file_handle.flush() {
        return Err(DownloadError::Other(format!(
            "flush {}: {e}",
            tmp.display()
        )));
    }
    drop(file_handle);

    // Verifying phase: emit one event so the UI can show "verifying" state
    // even though the hash was computed in-stream.
    emit_progress(
        app,
        &ProgressEvent {
            model_id: model_id.to_string(),
            file: file.kind.label(),
            file_index,
            file_count,
            bytes_received,
            total_bytes: total,
            phase: ProgressPhase::Verifying,
            error: None,
        },
    );

    // A short read or hash mismatch means the bytes on disk are wrong —
    // delete the .tmp so a later resume can't continue from corrupt data.
    if file.size_bytes != 0 && bytes_received != file.size_bytes {
        let _ = fs::remove_file(&tmp);
        return Err(DownloadError::Other(format!(
            "{} short read: expected {} bytes, got {}",
            file.url, file.size_bytes, bytes_received
        )));
    }
    let computed = hex::encode(hasher.finalize());
    if !computed.eq_ignore_ascii_case(&file.sha256_hex) {
        let _ = fs::remove_file(&tmp);
        return Err(DownloadError::Other(format!(
            "{} sha256 mismatch: expected {}, got {}",
            file.url, file.sha256_hex, computed
        )));
    }

    // Atomic rename — the model is only "installed" once this returns Ok.
    fs::rename(&tmp, target).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        DownloadError::Other(format!(
            "rename {} -> {}: {e}",
            tmp.display(),
            target.display()
        ))
    })?;

    emit_progress(
        app,
        &ProgressEvent {
            model_id: model_id.to_string(),
            file: file.kind.label(),
            file_index,
            file_count,
            bytes_received,
            total_bytes: total,
            phase: ProgressPhase::Done,
            error: None,
        },
    );

    Ok(())
}

// Streams the file in 64 KiB chunks rather than `fs::read`-ing the whole thing
// into memory. The fast-path skip checks an existing on-disk artifact against
// the manifest's expected hash; multi-GB GGUFs would otherwise spike RAM by
// the file's size on the resume path.
fn hash_file_blocking(path: &Path) -> Result<String, String> {
    use std::io::{BufReader, Read};
    let file = File::open(path).map_err(|e| format!("open {}: {e}", path.display()))?;
    let mut reader = BufReader::with_capacity(64 * 1024, file);
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = reader
            .read(&mut buf)
            .map_err(|e| format!("read {}: {e}", path.display()))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex::encode(hasher.finalize()))
}

// Seeds a Sha256 with a partial .tmp's bytes so a Range-resumed download
// still verifies the complete file. Returns the byte count actually hashed —
// that count (not a separately-stat'd length) is the resume offset sent in
// the Range header, so hasher state and offset can never disagree.
fn seed_hasher_blocking(path: &Path) -> Result<(Sha256, u64), String> {
    use std::io::{BufReader, Read};
    let file = File::open(path).map_err(|e| format!("open {}: {e}", path.display()))?;
    let mut reader = BufReader::with_capacity(64 * 1024, file);
    let mut hasher = Sha256::new();
    let mut hashed: u64 = 0;
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = reader
            .read(&mut buf)
            .map_err(|e| format!("read {}: {e}", path.display()))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        hashed += n as u64;
    }
    Ok((hasher, hashed))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_id_accepts_normal_ids() {
        validate_model_id("moondream2").unwrap();
        validate_model_id("qwen2_5-vl-7b").unwrap();
        validate_model_id("a.b").unwrap();
    }

    #[test]
    fn validate_id_rejects_traversal() {
        assert!(validate_model_id("..").is_err());
        assert!(validate_model_id(".hidden").is_err());
        assert!(validate_model_id("a/b").is_err());
        assert!(validate_model_id("").is_err());
        assert!(validate_model_id(&"x".repeat(65)).is_err());
        assert!(validate_model_id("with space").is_err());
    }

    #[test]
    fn seed_hasher_matches_full_hash_when_remainder_is_appended() {
        let path = std::env::temp_dir().join(format!("studyvis-seed-test-{}", std::process::id()));
        let full: Vec<u8> = (0u32..100_000).map(|i| (i % 251) as u8).collect();
        let split = 33_333;
        fs::write(&path, &full[..split]).expect("write partial");

        let (mut seeded, hashed) = seed_hasher_blocking(&path).expect("seed");
        let _ = fs::remove_file(&path);
        assert_eq!(hashed, split as u64);

        seeded.update(&full[split..]);
        let mut whole = Sha256::new();
        whole.update(&full);
        assert_eq!(
            hex::encode(seeded.finalize()),
            hex::encode(whole.finalize())
        );
    }
}
