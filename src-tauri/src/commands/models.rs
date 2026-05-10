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
const HTTP_TIMEOUT: Duration = Duration::from_secs(120);

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

#[tauri::command]
pub fn model_remove<R: Runtime>(app: AppHandle<R>, model_id: String) -> Result<(), String> {
    let dir = model_dir(&app, &model_id)?;
    if dir.exists() {
        fs::remove_dir_all(&dir).map_err(|e| format!("remove model dir: {e}"))?;
    }
    Ok(())
}

#[derive(Serialize)]
pub struct HeadResult {
    pub status: u16,
    pub content_length: Option<u64>,
}

fn build_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(HTTP_TIMEOUT)
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
            // Best-effort cleanup: every per-file download deletes its own
            // .tmp on cancel, but if the cancel landed between files we may
            // already have a verified target file from an earlier file.
            // Leave verified files in place — the UI's install_state probe
            // will report partial install and the user can re-download.
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
                    let computed = hash_file_blocking(&target).map_err(DownloadError::Other)?;
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
    if tmp.exists() {
        let _ = fs::remove_file(&tmp);
    }

    let mut req = client.get(&file.url);
    if let Some(t) = token {
        req = req.bearer_auth(t);
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
    let total = resp.content_length().unwrap_or(file.size_bytes);

    let mut file_handle = File::create(&tmp)
        .map_err(|e| DownloadError::Other(format!("create {}: {e}", tmp.display())))?;
    let mut hasher = Sha256::new();
    let mut bytes_received: u64 = 0;
    let mut last_event_bytes: u64 = 0;
    let mut last_event_at = Instant::now();

    // Emit a 0-byte progress event so the UI sees the per-file phase
    // transition immediately.
    emit_progress(
        app,
        &ProgressEvent {
            model_id: model_id.to_string(),
            file: file.kind.label(),
            file_index,
            file_count,
            bytes_received: 0,
            total_bytes: total,
            phase: ProgressPhase::Downloading,
            error: None,
        },
    );

    let mut stream = resp.bytes_stream();
    while let Some(chunk_result) = stream.next().await {
        if cancel.load(Ordering::SeqCst) {
            drop(file_handle);
            let _ = fs::remove_file(&tmp);
            return Err(DownloadError::Cancelled);
        }
        let chunk = chunk_result.map_err(|e| DownloadError::Other(format!("stream chunk: {e}")))?;
        hasher.update(&chunk);
        file_handle
            .write_all(&chunk)
            .map_err(|e| DownloadError::Other(format!("write {}: {e}", tmp.display())))?;
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

    file_handle
        .flush()
        .map_err(|e| DownloadError::Other(format!("flush {}: {e}", tmp.display())))?;
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

fn hash_file_blocking(path: &Path) -> Result<String, String> {
    let bytes = fs::read(path).map_err(|e| format!("read {}: {e}", path.display()))?;
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    Ok(hex::encode(hasher.finalize()))
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
}
