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
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Weak};
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::async_runtime::Mutex;
use tauri::{AppHandle, Emitter, Runtime, State};

#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
use keyring::Entry;

use crate::db::data_dir;

const MODELS_DIR: &str = "models";
const MODEL_LOCAL_FILENAME: &str = "model.gguf";
const MMPROJ_LOCAL_FILENAME: &str = "mmproj.gguf";
const TMP_SUFFIX: &str = ".tmp";
const HUGGING_FACE_HOST: &str = "huggingface.co";

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

#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
const KEYRING_SERVICE: &str = "com.studyvis.app";
#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
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

// A model URL comes from the frontend manifest, but it is still IPC input. In
// particular, the optional Hugging Face token must never be attached to an
// attacker-controlled URL. Restrict the endpoint to the immutable resolve URL
// shape produced by `huggingfaceResolveUrl` in `src/features/ai/models.ts`.
fn trusted_hugging_face_url(raw: &str) -> Result<reqwest::Url, String> {
    let url = reqwest::Url::parse(raw).map_err(|e| format!("invalid model URL: {e}"))?;
    if url.scheme() != "https"
        || url.host_str() != Some(HUGGING_FACE_HOST)
        || url.port_or_known_default() != Some(443)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("model URL must be an HTTPS Hugging Face resolve URL".into());
    }

    let segments: Vec<_> = url
        .path_segments()
        .ok_or_else(|| "model URL must be an HTTPS Hugging Face resolve URL".to_string())?
        .collect();
    let valid_path = segments.len() >= 5
        && !segments[0].is_empty()
        && !segments[1].is_empty()
        && segments[2] == "resolve"
        && !segments[3].is_empty()
        && segments[4..]
            .iter()
            .all(|segment| !segment.is_empty() && *segment != "." && *segment != "..");
    if !valid_path {
        return Err("model URL must be an HTTPS Hugging Face resolve URL".into());
    }
    Ok(url)
}

fn validate_model_file_requests(files: &[ModelFileRequest]) -> Result<(), String> {
    for file in files {
        trusted_hugging_face_url(&file.url)
            .map_err(|e| format!("{} file URL: {e}", file.kind.label()))?;
    }
    Ok(())
}

fn managed_model_id_from_relative(relative: &Path) -> Option<String> {
    let mut components = relative.components();
    let Component::Normal(model_id) = components.next()? else {
        return None;
    };
    let Component::Normal(filename) = components.next()? else {
        return None;
    };
    if components.next().is_some()
        || (filename != std::ffi::OsStr::new(MODEL_LOCAL_FILENAME)
            && filename != std::ffi::OsStr::new(MMPROJ_LOCAL_FILENAME))
    {
        return None;
    }
    let model_id = model_id.to_str()?.to_string();
    validate_model_id(&model_id).ok()?;
    Some(model_id)
}

// `sidecar_start` accepts advanced/custom GGUF paths, so only take a model
// operation lock when an input is exactly one of our managed model files. The
// direct lexical check covers the normal `model_paths` result without I/O; the
// canonical fallback handles an equivalent path containing `.` / `..`.
pub(crate) fn managed_model_id_for_path<R: Runtime>(
    app: &AppHandle<R>,
    path: &str,
) -> Result<Option<String>, String> {
    let root = models_root(app)?;
    let candidate = Path::new(path);
    if let Ok(relative) = candidate.strip_prefix(&root) {
        if let Some(model_id) = managed_model_id_from_relative(relative) {
            return Ok(Some(model_id));
        }
    }

    let Ok(canonical_root) = fs::canonicalize(&root) else {
        return Ok(None);
    };
    let Ok(canonical_path) = fs::canonicalize(candidate) else {
        return Ok(None);
    };
    Ok(canonical_path
        .strip_prefix(canonical_root)
        .ok()
        .and_then(managed_model_id_from_relative))
}

pub(crate) fn managed_model_ids_for_paths<R: Runtime>(
    app: &AppHandle<R>,
    model_path: &str,
    mmproj_path: Option<&str>,
) -> Result<Vec<String>, String> {
    let mut ids = Vec::with_capacity(2);
    if let Some(model_id) = managed_model_id_for_path(app, model_path)? {
        ids.push(model_id);
    }
    if let Some(mmproj_path) = mmproj_path {
        if let Some(model_id) = managed_model_id_for_path(app, mmproj_path)? {
            ids.push(model_id);
        }
    }
    ids.sort_unstable();
    ids.dedup();
    Ok(ids)
}

#[derive(Default)]
struct ModelOperationInner {
    // Weak entries are pruned on the next acquisition, so hostile IPC cannot
    // permanently grow this map by naming arbitrary (but syntactically valid)
    // model IDs. A live operation or waiter owns the corresponding Arc.
    gates: HashMap<String, Weak<Mutex<()>>>,
}

// Coordinates mutations of one managed model directory with starts that use
// it. The guard is intentionally held through a multi-GB download: remove
// must either cancel-and-wait for that operation, or run before it, never
// delete the directory beneath its open temporary file.
pub struct ModelOperationState(Arc<Mutex<ModelOperationInner>>);

impl ModelOperationState {
    pub fn new() -> Self {
        Self(Arc::new(Mutex::new(ModelOperationInner::default())))
    }

    pub(crate) async fn gates_for(&self, model_ids: &[String]) -> Vec<Arc<Mutex<()>>> {
        let mut inner = self.0.lock().await;
        inner.gates.retain(|_, gate| gate.strong_count() > 0);
        model_ids
            .iter()
            .map(|model_id| {
                if let Some(gate) = inner.gates.get(model_id).and_then(|gate| gate.upgrade()) {
                    return gate;
                }
                let gate = Arc::new(Mutex::new(()));
                inner.gates.insert(model_id.clone(), Arc::downgrade(&gate));
                gate
            })
            .collect()
    }
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
    downloads: State<'_, DownloadState>,
    operations: State<'_, ModelOperationState>,
    model_id: String,
) -> Result<(), String> {
    validate_model_id(&model_id)?;
    // If a download already owns this model directory, ask it to stop before
    // waiting for the operation gate. The next command then removes the
    // verified files and any resumable .tmp as one serialized operation.
    request_download_cancel(&downloads, &model_id).await;
    let operation_gates = operations.gates_for(std::slice::from_ref(&model_id)).await;
    let _operation_guard = operation_gates[0].clone().lock_owned().await;
    let dir = model_dir(&app, &model_id)?;
    let stopped = crate::commands::sidecar::stop_if_serving_model(&sidecar, &model_id).await?;
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

pub(crate) fn build_client() -> Result<reqwest::Client, String> {
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
    let url = trusted_hugging_face_url(&url)?;
    let client = build_client()?;
    let mut req = client.head(url.clone());
    if with_token {
        if let Some(token) = load_hf_token_internal() {
            req = req.bearer_auth(token);
        }
    }
    let resp = req.send().await.map_err(|e| format!("HEAD {url}: {e}"))?;
    let status = resp.status();
    // I72 — read the Content-Length header, not resp.content_length(): the
    // latter is the body's size hint, and a HEAD response body is always
    // empty over HTTP/1.1, so it reported 0 bytes for every probe and the
    // picker's size preflight rejected every download.
    let content_length = content_length_from_headers(resp.headers());
    Ok(HeadResult {
        status: status.as_u16(),
        content_length,
    })
}

fn content_length_from_headers(headers: &reqwest::header::HeaderMap) -> Option<u64> {
    headers
        .get(reqwest::header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse::<u64>().ok())
}

// ── Hugging Face access token (mac + win only — Linux deferred with V1-P3) ──

#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
fn hf_token_entry() -> Result<Entry, String> {
    Entry::new(KEYRING_SERVICE, KEYRING_USER_HF_TOKEN).map_err(|e| e.to_string())
}

#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
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

#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
#[tauri::command]
pub fn hf_token_present() -> Result<bool, String> {
    match hf_token_entry()?.get_password() {
        Ok(s) => Ok(!s.is_empty()),
        Err(keyring::Error::NoEntry) => Ok(false),
        Err(e) => Err(format!("keyring get: {e}")),
    }
}

#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
#[tauri::command]
pub fn hf_token_clear() -> Result<(), String> {
    match hf_token_entry()?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("keyring delete: {e}")),
    }
}

#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
fn load_hf_token_internal() -> Option<String> {
    match Entry::new(KEYRING_SERVICE, KEYRING_USER_HF_TOKEN)
        .ok()?
        .get_password()
    {
        Ok(s) if !s.is_empty() => Some(s),
        _ => None,
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
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

async fn request_download_cancel(state: &DownloadState, model_id: &str) {
    let arc = state.0.clone();
    let guard = arc.lock().await;
    if let Some(flag) = guard.cancellations.get(model_id) {
        flag.store(true, Ordering::SeqCst);
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
    sidecar: State<'_, crate::commands::sidecar::SidecarState>,
    operations: State<'_, ModelOperationState>,
    model_id: String,
    files: Vec<ModelFileRequest>,
    use_token: bool,
) -> Result<(), String> {
    if files.is_empty() {
        return Err("files must not be empty".into());
    }
    validate_model_id(&model_id)?;
    validate_model_file_requests(&files)?;

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

    // Register cancellation BEFORE waiting for the model-operation gate.
    // `model_remove` first flips this flag and then waits for that same gate;
    // registering after acquisition would leave a narrow interval where a
    // remove misses the flag and must wait for a multi-GB download to finish.
    let outcome = async {
        let operation_gates = operations.gates_for(std::slice::from_ref(&model_id)).await;
        let _operation_guard = operation_gates[0].clone().lock_owned().await;
        if cancel.load(Ordering::SeqCst) {
            return Err(DownloadError::Cancelled);
        }

        let dir = model_dir(&app, &model_id).map_err(DownloadError::Other)?;
        // Do not replace a model's files while llama-server could be mapping
        // the old generation. It also makes post-download state truthful: the
        // next explicit start always opens the files just verified below.
        crate::commands::sidecar::stop_if_serving_model(&sidecar, &model_id)
            .await
            .map_err(DownloadError::Other)?;
        fs::create_dir_all(&dir)
            .map_err(|e| DownloadError::Other(format!("create model dir: {e}")))?;

        // Do not fetch a keychain secret until this queued operation actually
        // owns the directory and is about to make its validated request.
        let token = if use_token {
            load_hf_token_internal()
        } else {
            None
        };

        // Run the per-file downloads sequentially. We don't parallelize: HF's
        // CDN throttles per-connection and parallel HTTP/2 streams for the
        // same origin would just contend. Sequential keeps progress simple.
        run_download(&app, &dir, &model_id, &files, token, &cancel).await
    }
    .await;

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
    validate_model_id(&model_id)?;
    request_download_cancel(&state, &model_id).await;
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
    // Re-validate at the bearer-auth boundary as defense in depth. The command
    // validates every request before acquiring a model-operation lock, but this
    // helper is also the one place that constructs the authenticated GET.
    let url = trusted_hugging_face_url(&file.url).map_err(DownloadError::Other)?;
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

    let mut req = client.get(url.clone());
    if let Some(t) = token {
        req = req.bearer_auth(t);
    }
    if resume_offset > 0 {
        req = req.header(reqwest::header::RANGE, format!("bytes={resume_offset}-"));
    }
    let resp = req
        .send()
        .await
        .map_err(|e| DownloadError::Other(format!("GET {url}: {e}")))?;
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
            url, status, hint
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
            url, file.size_bytes, bytes_received
        )));
    }
    let computed = hex::encode(hasher.finalize());
    if !computed.eq_ignore_ascii_case(&file.sha256_hex) {
        let _ = fs::remove_file(&tmp);
        return Err(DownloadError::Other(format!(
            "{} sha256 mismatch: expected {}, got {}",
            url, file.sha256_hex, computed
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

    // I72 — a HEAD response body is empty, so reqwest's content_length()
    // (the body size hint) is always 0 over HTTP/1.1; the command must
    // report the Content-Length header instead.
    #[test]
    fn head_check_reports_header_content_length() {
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert(
            reqwest::header::CONTENT_LENGTH,
            reqwest::header::HeaderValue::from_static("12345"),
        );
        assert_eq!(content_length_from_headers(&headers), Some(12345));
    }

    // Absent or malformed Content-Length must degrade to None ("unknown"),
    // which the JS preflight treats as skip-the-size-gate — the download's
    // exact-byte + sha256 checks still gate integrity.
    #[test]
    fn head_check_reports_none_without_content_length() {
        assert_eq!(
            content_length_from_headers(&reqwest::header::HeaderMap::new()),
            None
        );
    }

    #[test]
    fn head_check_reports_none_for_malformed_content_length() {
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert(
            reqwest::header::CONTENT_LENGTH,
            reqwest::header::HeaderValue::from_static("12345abc"),
        );
        assert_eq!(content_length_from_headers(&headers), None);
    }

    #[test]
    fn trusted_model_url_accepts_the_catalog_resolve_shape() {
        let url = trusted_hugging_face_url(
            "https://huggingface.co/ggml-org/model/resolve/0123456789abcdef/model.gguf",
        )
        .expect("catalog URL must be allowed");
        assert_eq!(url.host_str(), Some(HUGGING_FACE_HOST));
    }

    #[test]
    fn trusted_model_url_rejects_non_hugging_face_or_non_resolve_urls() {
        for url in [
            "http://huggingface.co/ggml-org/model/resolve/rev/model.gguf",
            "https://huggingface.co.evil.example/ggml-org/model/resolve/rev/model.gguf",
            "https://huggingface.co:444/ggml-org/model/resolve/rev/model.gguf",
            "https://huggingface.co/ggml-org/model/blob/rev/model.gguf",
            "https://token@huggingface.co/ggml-org/model/resolve/rev/model.gguf",
            "https://huggingface.co/ggml-org/model/resolve/rev/model.gguf?download=true",
        ] {
            assert!(trusted_hugging_face_url(url).is_err(), "must reject {url}");
        }
    }

    #[test]
    fn managed_model_path_parser_only_accepts_our_two_model_filenames() {
        assert_eq!(
            managed_model_id_from_relative(Path::new("qwen/model.gguf")),
            Some("qwen".to_string())
        );
        assert_eq!(
            managed_model_id_from_relative(Path::new("qwen/mmproj.gguf")),
            Some("qwen".to_string())
        );
        assert_eq!(
            managed_model_id_from_relative(Path::new("qwen/other.gguf")),
            None
        );
        assert_eq!(
            managed_model_id_from_relative(Path::new("qwen/nested/model.gguf")),
            None
        );
    }

    #[test]
    fn model_operation_state_reuses_a_live_model_gate() {
        let state = ModelOperationState::new();
        let ids = vec!["qwen".to_string()];
        let first = tauri::async_runtime::block_on(state.gates_for(&ids));
        let second = tauri::async_runtime::block_on(state.gates_for(&ids));
        assert!(Arc::ptr_eq(&first[0], &second[0]));
    }

    #[test]
    fn cancellation_request_flips_a_registered_download_flag() {
        let state = DownloadState::new();
        let flag = Arc::new(AtomicBool::new(false));
        tauri::async_runtime::block_on(async {
            {
                let mut guard = state.0.lock().await;
                guard.cancellations.insert("qwen".to_string(), flag.clone());
            }
            request_download_cancel(&state, "qwen").await;
        });
        assert!(flag.load(Ordering::SeqCst));
    }

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
