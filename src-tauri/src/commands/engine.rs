//! I73 — llama-server engine auto-install.
//!
//! The bundled sidecar (`tauri.conf.json` `externalBin`, fetched at build
//! time by `scripts/fetch-llama-server.sh`) stays the primary engine. This
//! module is the runtime fallback that makes a fresh dev checkout and a
//! damaged install self-heal: download the pinned llama.cpp release archive
//! for the current target triple, verify its SHA-256, unpack `llama-server`
//! plus its companion libraries into
//! `data_dir/engine/<tag>-r<package-revision>-<triple>/`, and hand spawn-ready
//! candidate paths to `commands/sidecar.rs`.
//!
//! The release pins below are in LOCKSTEP with scripts/fetch-llama-server.sh —
//! `pins_match_fetch_script` fails `cargo test` when they drift. Bumping the
//! tag also requires bumping INFERENCE_ENGINE_FINGERPRINT in
//! src/features/ai/benchmark.ts (persisted benchmarks go stale).

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{path::BaseDirectory, AppHandle, Emitter, Manager, Runtime, State};
use tauri_plugin_shell::ShellExt;

use super::models::build_client;
use super::sidecar::{SidecarState, TARGET_TRIPLE};
use crate::db::data_dir;

pub const ENGINE_TAG: &str = "b9095";
// The upstream tag alone is not enough to identify a compatible managed
// package: #211 switches Windows from b9095's CPU archive to its Vulkan
// archive without changing the upstream tag. Keep a package revision in the
// managed directory name so a damaged future bundle never falls back to an
// old CPU-only cache and then rejects a persisted Vulkan device selection.
const ENGINE_PACKAGE_REVISION: &str = "2";
const RELEASE_BASE: &str = "https://github.com/ggml-org/llama.cpp/releases/download";
const ENGINE_DIR: &str = "engine";

// Anything smaller cannot be a real llama-server (the smallest prebuilt is
// ~9 MB); this gate is what filters out the dev placeholder that build.rs
// writes so `cargo` can compile without scripts/fetch-llama-server.sh.
const MIN_REAL_ENGINE_BYTES: u64 = 4 * 1024 * 1024;

const PROGRESS_EVENT_NAME: &str = "engine:progress";
const PROGRESS_EVENT_BYTES: u64 = 1024 * 1024;
const PROGRESS_EVENT_INTERVAL: Duration = Duration::from_millis(250);

struct EngineAsset {
    triple: &'static str,
    asset: &'static str,
    sha256: &'static str,
}

// SHA-256s verified against the official b9095 release assets; they match
// scripts/fetch-llama-server.sh's pins byte-for-byte (test below). Windows
// deliberately uses the Vulkan package so NVIDIA/AMD/Intel/eGPU devices share
// one backend while CPU remains available through llama.cpp's --device none.
const ENGINE_ASSETS: &[EngineAsset] = &[
    EngineAsset {
        triple: "aarch64-apple-darwin",
        asset: "llama-b9095-bin-macos-arm64.tar.gz",
        sha256: "90fea82a8e712274adcdc90ceb6c993d959c1c49bbbb77b97584986c9e366bdd",
    },
    EngineAsset {
        triple: "x86_64-apple-darwin",
        asset: "llama-b9095-bin-macos-x64.tar.gz",
        sha256: "a9e6c3967d2d0d96b5a72a4b5610b14945d8b8448e510a4b3d012a3c7284566f",
    },
    EngineAsset {
        triple: "x86_64-pc-windows-msvc",
        asset: "llama-b9095-bin-win-vulkan-x64.zip",
        sha256: "297209d9f17ac0c25cd146c8e0b11bdb77fc672512aba84045e20ab0d51c96a9",
    },
    EngineAsset {
        triple: "x86_64-unknown-linux-gnu",
        asset: "llama-b9095-bin-ubuntu-x64.tar.gz",
        sha256: "167e12288da2dc4dcece7327010844edcfb18ee3a76eb45b2e232a04723865e6",
    },
];

fn asset_for(triple: &str) -> Option<&'static EngineAsset> {
    ENGINE_ASSETS.iter().find(|a| a.triple == triple)
}

fn binary_name() -> &'static str {
    if cfg!(windows) {
        "llama-server.exe"
    } else {
        "llama-server"
    }
}

fn engine_root<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    Ok(data_dir(app)?.join(ENGINE_DIR))
}

fn managed_install_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    Ok(engine_root(app)?.join(format!(
        "{ENGINE_TAG}-r{ENGINE_PACKAGE_REVISION}-{TARGET_TRIPLE}"
    )))
}

fn managed_binary_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    Ok(managed_install_dir(app)?.join(binary_name()))
}

// The bundled sidecar as tauri-build/the bundler actually lay it down: next
// to the app executable, directory prefix and target-triple suffix stripped
// (verified in both target/debug/ and StudyVis.app/Contents/MacOS/). The
// size gate rejects the dev placeholder. Returns None when absent — the
// caller falls through to the managed install.
fn bundled_binary_path() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    // cargo-test binaries run from target/<profile>/deps; the copied sidecar
    // sits one level up (same quirk tauri-plugin-shell handles).
    let dir = if dir.ends_with("deps") {
        dir.parent()?
    } else {
        dir
    };
    let path = dir.join(binary_name());
    let meta = fs::metadata(&path).ok()?;
    (meta.is_file() && meta.len() >= MIN_REAL_ENGINE_BYTES).then_some(path)
}

#[derive(Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum EngineSource {
    Bundled,
    Managed,
}

// Spawn candidates in preference order: bundled first (the release-tested
// path), managed second. Both resolve the same pinned tag + package revision,
// so fallback cannot resurrect a pre-#211 CPU-only Windows engine.
pub fn resolve_candidates<R: Runtime>(app: &AppHandle<R>) -> Vec<(EngineSource, PathBuf)> {
    let mut candidates = Vec::new();
    if let Some(path) = bundled_binary_path() {
        candidates.push((EngineSource::Bundled, path));
    }
    if let Ok(path) = managed_binary_path(app) {
        if path.is_file() {
            candidates.push((EngineSource::Managed, path));
        }
    }
    candidates
}

fn runtime_dir_for<R: Runtime>(
    app: &AppHandle<R>,
    source: EngineSource,
    binary: &Path,
) -> Option<PathBuf> {
    match source {
        EngineSource::Bundled => {
            let rel = format!("binaries/llama-runtime-{TARGET_TRIPLE}");
            app.path()
                .resolve(&rel, BaseDirectory::Resource)
                .ok()
                .filter(|path| path.is_dir())
                .or_else(|| binary.parent().map(Path::to_path_buf))
        }
        EngineSource::Managed => binary.parent().map(Path::to_path_buf),
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct EngineDevice {
    pub id: String,
    pub label: String,
}

fn parse_device_list(output: &str) -> Vec<EngineDevice> {
    let mut devices = Vec::new();
    for line in output.lines() {
        let line = line.trim();
        let Some((raw_id, raw_label)) = line.split_once(':') else {
            continue;
        };
        let id = raw_id.trim().trim_start_matches(['-', '*']).trim();
        let label = raw_label.trim();
        if !super::compute_device::valid_device_id(id)
            || id.eq_ignore_ascii_case("cpu")
            || label.is_empty()
            || devices.iter().any(|device: &EngineDevice| device.id == id)
        {
            continue;
        }
        devices.push(EngineDevice {
            id: id.to_owned(),
            label: label.to_owned(),
        });
    }
    devices
}

fn bounded_command_error(value: &str) -> String {
    const MAX_CHARS: usize = 512;
    let compact = value.split_whitespace().collect::<Vec<_>>().join(" ");
    compact.chars().take(MAX_CHARS).collect()
}

async fn devices_for_candidate<R: Runtime>(
    app: &AppHandle<R>,
    source: EngineSource,
    binary: &Path,
) -> Result<Vec<EngineDevice>, String> {
    let runtime_dir = runtime_dir_for(app, source, binary);
    let mut command = app.shell().command(binary).arg("--list-devices");
    if let Some(dir) = runtime_dir.as_deref() {
        command = command.current_dir(dir);
        let dir_str = dir.to_string_lossy().into_owned();
        #[cfg(target_os = "macos")]
        {
            const KEY: &str = "DYLD_FALLBACK_LIBRARY_PATH";
            let combined = match std::env::var(KEY) {
                Ok(prev) if !prev.is_empty() => format!("{dir_str}:{prev}"),
                _ => dir_str,
            };
            command = command.env(KEY, combined);
        }
        #[cfg(target_os = "linux")]
        {
            const KEY: &str = "LD_LIBRARY_PATH";
            let combined = match std::env::var(KEY) {
                Ok(prev) if !prev.is_empty() => format!("{dir_str}:{prev}"),
                _ => dir_str,
            };
            command = command.env(KEY, combined);
        }
        #[cfg(target_os = "windows")]
        {
            let combined = match std::env::var("PATH") {
                Ok(prev) if !prev.is_empty() => format!("{dir_str};{prev}"),
                _ => dir_str,
            };
            command = command.env("PATH", combined);
        }
    }

    let output = command
        .output()
        .await
        .map_err(|e| format!("list devices via {}: {e}", binary.display()))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    if !output.status.success() {
        let detail = bounded_command_error(if stderr.trim().is_empty() {
            stdout.as_ref()
        } else {
            stderr.as_ref()
        });
        return Err(if detail.is_empty() {
            format!(
                "{} --list-devices exited with {:?}",
                binary.display(),
                output.status.code()
            )
        } else {
            format!("{} --list-devices: {detail}", binary.display())
        });
    }

    let mut combined = String::with_capacity(stdout.len() + stderr.len() + 1);
    combined.push_str(&stdout);
    combined.push('\n');
    combined.push_str(&stderr);
    Ok(parse_device_list(&combined))
}

async fn discover_devices<R: Runtime>(
    app: &AppHandle<R>,
    candidates: &[(EngineSource, PathBuf)],
) -> (Vec<EngineDevice>, Option<String>) {
    let mut last_error = None;
    for (source, binary) in candidates {
        match devices_for_candidate(app, *source, binary).await {
            Ok(devices) => return (devices, None),
            Err(error) => last_error = Some(error),
        }
    }
    (Vec::new(), last_error)
}

#[derive(Default)]
struct EngineMeta {
    installing: bool,
    last_error: Option<String>,
}

pub struct EngineState {
    // Serializes installs; every entrant re-checks "already installed" after
    // acquiring, so concurrent callers (sidecar_start auto-install racing the
    // Settings button) both succeed instead of one erroring "in flight".
    // pub(crate) so sidecar_start can hold it across resolve + spawn (PR-88
    // review — a forced reinstall must not swap the managed dir under a
    // child being spawned). Lock ORDER: this gate before the sidecar lock,
    // never the reverse. Not reentrant — never hold it while calling
    // ensure_installed/engine_install.
    pub(crate) gate: tauri::async_runtime::Mutex<()>,
    // Short-hold metadata for engine_info; never held across an await.
    meta: std::sync::Mutex<EngineMeta>,
}

impl EngineState {
    pub fn new() -> Self {
        Self {
            gate: tauri::async_runtime::Mutex::new(()),
            meta: std::sync::Mutex::new(EngineMeta::default()),
        }
    }
}

#[derive(Serialize)]
pub struct EngineInfo {
    pub supported: bool,
    pub installed: bool,
    pub source: Option<EngineSource>,
    pub version: String,
    pub installing: bool,
    pub last_error: Option<String>,
    pub devices: Vec<EngineDevice>,
    pub device_error: Option<String>,
}

#[tauri::command]
pub async fn engine_info<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, EngineState>,
) -> Result<EngineInfo, String> {
    let candidates = resolve_candidates(&app);
    let (devices, device_error) = discover_devices(&app, &candidates).await;
    let meta = state.meta.lock().map_err(|e| e.to_string())?;
    Ok(EngineInfo {
        supported: asset_for(TARGET_TRIPLE).is_some(),
        installed: !candidates.is_empty(),
        source: candidates.first().map(|(source, _)| *source),
        version: ENGINE_TAG.to_string(),
        installing: meta.installing,
        last_error: meta.last_error.clone(),
        devices,
        device_error,
    })
}

#[derive(Serialize, Clone)]
pub struct EngineProgressEvent {
    pub phase: EnginePhase,
    pub bytes_received: u64,
    pub total_bytes: u64,
    pub error: Option<String>,
}

#[derive(Serialize, Clone, Copy)]
#[serde(rename_all = "snake_case")]
pub enum EnginePhase {
    Downloading,
    Verifying,
    Extracting,
    Done,
    Failed,
}

fn emit_progress<R: Runtime>(app: &AppHandle<R>, event: &EngineProgressEvent) {
    let _ = app.emit(PROGRESS_EVENT_NAME, event);
}

// Manual install / reinstall from Settings → AI. Takes the install gate
// FIRST, then stops the sidecar, then swaps the engine dir — all under one
// gate hold, so no sidecar_start (which also acquires gate before the
// sidecar lock) can spawn from the directory mid-swap, and on Windows no
// child holds the DLLs being replaced. Lock ORDER everywhere: engine gate →
// sidecar lock, never the reverse (stop_now takes and RELEASES the sidecar
// lock internally and never touches the gate).
#[tauri::command]
pub async fn engine_install<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, EngineState>,
    sidecar: State<'_, SidecarState>,
) -> Result<(), String> {
    let _gate = state.gate.lock().await;
    super::sidecar::stop_now(&sidecar).await?;
    install_locked(&app, &state, true).await
}

// sidecar_start's auto-install path: no-op when any candidate already
// resolves. Never forces — a corrupt managed install is repaired via the
// Settings Reinstall button, not silently re-downloaded on every start.
pub async fn ensure_installed<R: Runtime>(
    app: &AppHandle<R>,
    state: &EngineState,
) -> Result<(), String> {
    let _gate = state.gate.lock().await;
    install_locked(app, state, false).await
}

// Callers hold `gate`. Every entrant re-checks "already installed" after
// acquiring, so concurrent callers coalesce instead of erroring "in flight".
async fn install_locked<R: Runtime>(
    app: &AppHandle<R>,
    state: &EngineState,
    force: bool,
) -> Result<(), String> {
    // A process loss between the two promotion renames leaves the prior
    // complete install in the rollback directory. Restore it before deciding
    // whether an install is needed, so a crash during a forced reinstall does
    // not turn an otherwise usable offline engine into a fresh download.
    recover_interrupted_promotion(&managed_install_dir(app)?)?;
    if !force {
        if let Ok(path) = managed_binary_path(app) {
            if path.is_file() {
                return Ok(());
            }
        }
    }
    {
        let mut meta = state.meta.lock().map_err(|e| e.to_string())?;
        meta.installing = true;
        meta.last_error = None;
    }
    let result = do_install(app).await;
    {
        let mut meta = state.meta.lock().map_err(|e| e.to_string())?;
        meta.installing = false;
        meta.last_error = result.as_ref().err().cloned();
    }
    match &result {
        Ok(()) => emit_progress(
            app,
            &EngineProgressEvent {
                phase: EnginePhase::Done,
                bytes_received: 0,
                total_bytes: 0,
                error: None,
            },
        ),
        Err(e) => emit_progress(
            app,
            &EngineProgressEvent {
                phase: EnginePhase::Failed,
                bytes_received: 0,
                total_bytes: 0,
                error: Some(e.clone()),
            },
        ),
    }
    result
}

async fn do_install<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let asset = asset_for(TARGET_TRIPLE)
        .ok_or_else(|| format!("no prebuilt llama.cpp {ENGINE_TAG} engine for {TARGET_TRIPLE}"))?;
    let root = engine_root(app)?;
    fs::create_dir_all(&root).map_err(|e| format!("create engine dir: {e}"))?;
    cleanup_stale(&root);

    let archive_path = root.join(format!(".download-{}", asset.asset));
    download_verified(app, asset, &archive_path).await?;

    emit_progress(
        app,
        &EngineProgressEvent {
            phase: EnginePhase::Extracting,
            bytes_received: 0,
            total_bytes: 0,
            error: None,
        },
    );
    let staging = root.join(format!(
        ".tmp-{ENGINE_TAG}-r{ENGINE_PACKAGE_REVISION}-{TARGET_TRIPLE}"
    ));
    let extract_result = {
        let archive_path = archive_path.clone();
        let staging = staging.clone();
        tauri::async_runtime::spawn_blocking(move || {
            extract_archive(&archive_path, &staging, binary_name())
        })
        .await
        .map_err(|e| format!("extract task: {e}"))
        .and_then(|r| r)
    };
    // The archive is spent either way, and a failed extraction must not leave
    // staging debris (cleanup_stale would catch it next run, but a failed
    // manual install shouldn't wait for one).
    let _ = fs::remove_file(&archive_path);
    if let Err(e) = extract_result {
        let _ = fs::remove_dir_all(&staging);
        return Err(e);
    }

    let staged_binary = staging.join(binary_name());
    let staged_len = match fs::metadata(&staged_binary) {
        Ok(meta) => meta.len(),
        Err(e) => {
            let _ = fs::remove_dir_all(&staging);
            return Err(format!("{} missing from archive: {e}", binary_name()));
        }
    };
    if staged_len < MIN_REAL_ENGINE_BYTES {
        let _ = fs::remove_dir_all(&staging);
        return Err(format!(
            "extracted {} is unexpectedly small ({staged_len} bytes)",
            binary_name()
        ));
    }

    // Promote in a reversible two-rename transaction. `rename(staging,
    // final_dir)` cannot replace a non-empty directory on every supported
    // platform, so deleting `final_dir` first (the old implementation) left
    // users with no engine when the second rename failed. Moving the old
    // install aside keeps it intact until the staged replacement is known to
    // be in place; a failed promotion restores it before returning an error.
    // We hold the install gate, so nothing else touches these paths.
    let final_dir = managed_install_dir(app)?;
    let promote_result = promote_staged_install(&staging, &final_dir);
    if promote_result.is_err() {
        let _ = fs::remove_dir_all(&staging);
    }
    promote_result
}

// The staging directory is deliberately under the same engine root as the
// final directory, so both moves are same-filesystem renames. The rollback
// name is a fixed transaction journal: EngineState's gate serializes installs,
// and the stable path lets the next launch recognize and restore an interrupted
// promotion instead of discarding the only complete engine copy.
fn rollback_dir_for(final_dir: &Path) -> Result<PathBuf, String> {
    let parent = final_dir.parent().ok_or_else(|| {
        format!(
            "engine install directory has no parent: {}",
            final_dir.display()
        )
    })?;
    let name = final_dir
        .file_name()
        .ok_or_else(|| {
            format!(
                "engine install directory has no name: {}",
                final_dir.display()
            )
        })?
        .to_string_lossy();
    Ok(parent.join(format!(".{name}.rollback")))
}

// Recover the two crash states of a promotion before any cleanup sweep:
// - no final dir + rollback dir: the old install was moved aside but staging
//   was not promoted yet, so restore it;
// - both dirs: staging was promoted and only rollback cleanup was interrupted,
//   so retain the new final install and drop the old one.
fn recover_interrupted_promotion(final_dir: &Path) -> Result<(), String> {
    let rollback_dir = rollback_dir_for(final_dir)?;
    if !rollback_dir.exists() {
        return Ok(());
    }
    if final_dir.exists() {
        return fs::remove_dir_all(&rollback_dir)
            .map_err(|e| format!("clear completed engine rollback: {e}"));
    }
    fs::rename(&rollback_dir, final_dir)
        .map_err(|e| format!("restore interrupted engine install: {e}"))
}

fn promote_staged_install(staging: &Path, final_dir: &Path) -> Result<(), String> {
    let rollback_dir = rollback_dir_for(final_dir)?;
    let had_existing = final_dir.exists();

    if had_existing {
        if rollback_dir.exists() {
            fs::remove_dir_all(&rollback_dir)
                .map_err(|e| format!("clear stale engine rollback: {e}"))?;
        }
        fs::rename(final_dir, &rollback_dir)
            .map_err(|e| format!("stage previous engine for rollback: {e}"))?;
    }

    match fs::rename(staging, final_dir) {
        Ok(()) => {
            if had_existing {
                // A cleanup failure leaves a recoverable old engine directory,
                // not a broken installation. The next successful reinstall
                // retries its removal, so do not turn a successful promotion
                // into an apparent failure.
                let _ = fs::remove_dir_all(&rollback_dir);
            }
            Ok(())
        }
        Err(install_error) => {
            if !had_existing {
                return Err(format!("install engine: {install_error}"));
            }
            match fs::rename(&rollback_dir, final_dir) {
                Ok(()) => Err(format!(
                    "install engine: {install_error}; previous engine restored"
                )),
                Err(rollback_error) => Err(format!(
                    "install engine: {install_error}; failed to restore previous engine: {rollback_error}"
                )),
            }
        }
    }
}

async fn download_verified<R: Runtime>(
    app: &AppHandle<R>,
    asset: &EngineAsset,
    dest: &Path,
) -> Result<(), String> {
    let url = format!("{RELEASE_BASE}/{ENGINE_TAG}/{}", asset.asset);
    let client = build_client()?;
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("{url}: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("{url} returned HTTP {status}"));
    }
    // GET body size hint (fine here — I72 only bit HEAD responses). Zero when
    // unknown; the progress row copes.
    let total_bytes = resp.content_length().unwrap_or(0);

    let mut file = fs::File::create(dest).map_err(|e| format!("create {}: {e}", dest.display()))?;
    let mut hasher = Sha256::new();
    let mut bytes_received: u64 = 0;
    let mut last_event_bytes: u64 = 0;
    let mut last_event_at = Instant::now();
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = match chunk {
            Ok(c) => c,
            Err(e) => {
                let _ = fs::remove_file(dest);
                return Err(format!("{url}: {e}"));
            }
        };
        hasher.update(&chunk);
        if let Err(e) = file.write_all(&chunk) {
            let _ = fs::remove_file(dest);
            return Err(format!("write {}: {e}", dest.display()));
        }
        bytes_received += chunk.len() as u64;
        if bytes_received - last_event_bytes >= PROGRESS_EVENT_BYTES
            || last_event_at.elapsed() >= PROGRESS_EVENT_INTERVAL
        {
            last_event_bytes = bytes_received;
            last_event_at = Instant::now();
            emit_progress(
                app,
                &EngineProgressEvent {
                    phase: EnginePhase::Downloading,
                    bytes_received,
                    total_bytes,
                    error: None,
                },
            );
        }
    }
    drop(file);

    emit_progress(
        app,
        &EngineProgressEvent {
            phase: EnginePhase::Verifying,
            bytes_received,
            total_bytes,
            error: None,
        },
    );
    let computed = hex::encode(hasher.finalize());
    if !computed.eq_ignore_ascii_case(asset.sha256) {
        let _ = fs::remove_file(dest);
        return Err(format!(
            "{} sha256 mismatch: expected {}, got {computed}",
            asset.asset, asset.sha256
        ));
    }
    Ok(())
}

// Best-effort sweep of everything except the current install: superseded
// engine versions/package revisions, stale .tmp-* staging dirs, orphaned
// .download-* archives. The engine root is app-private, so anything
// unrecognized is ours to drop.
fn cleanup_stale(root: &Path) {
    let current = format!("{ENGINE_TAG}-r{ENGINE_PACKAGE_REVISION}-{TARGET_TRIPLE}");
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        if entry.file_name().to_string_lossy() == current.as_str() {
            continue;
        }
        let path = entry.path();
        let _ = if path.is_dir() {
            fs::remove_dir_all(&path)
        } else {
            fs::remove_file(&path)
        };
    }
}

// Keep llama-server itself plus the companion libraries the shared-libs
// prebuilds need (same set scripts/fetch-llama-server.sh copies), and the
// LICENSE. The other llama-* CLI tools are dead weight.
fn keep_entry(file_name: &str, bin_name: &str) -> bool {
    file_name == bin_name
        || file_name.ends_with(".dylib")
        || file_name.ends_with(".dll")
        || file_name.ends_with(".so")
        || file_name.contains(".so.")
        || file_name == "LICENSE"
}

// Entries are flattened to their file name (the archives keep everything in
// one directory anyway: tar.gz under a `llama-<tag>/` prefix, the Windows
// zip at the root). Joining only the file name makes path traversal a
// non-issue by construction.
fn extract_archive(archive: &Path, dest: &Path, bin_name: &str) -> Result<(), String> {
    if dest.exists() {
        fs::remove_dir_all(dest).map_err(|e| format!("clear staging dir: {e}"))?;
    }
    fs::create_dir_all(dest).map_err(|e| format!("create staging dir: {e}"))?;
    let is_zip = archive.extension().is_some_and(|ext| ext == "zip");
    if is_zip {
        extract_zip(archive, dest, bin_name)
    } else {
        extract_tar_gz(archive, dest, bin_name)
    }
}

fn extract_tar_gz(archive: &Path, dest: &Path, bin_name: &str) -> Result<(), String> {
    let file = fs::File::open(archive).map_err(|e| format!("open archive: {e}"))?;
    let decoder = flate2::read::GzDecoder::new(std::io::BufReader::new(file));
    let mut tar = tar::Archive::new(decoder);
    let entries = tar.entries().map_err(|e| format!("read archive: {e}"))?;
    for entry in entries {
        let mut entry = entry.map_err(|e| format!("read archive entry: {e}"))?;
        if !entry.header().entry_type().is_file() {
            continue;
        }
        let path = entry
            .path()
            .map_err(|e| format!("archive entry path: {e}"))?;
        let Some(name) = path.file_name().and_then(|n| n.to_str()).map(str::to_owned) else {
            continue;
        };
        if !keep_entry(&name, bin_name) {
            continue;
        }
        let out_path = dest.join(&name);
        let mut out = fs::File::create(&out_path)
            .map_err(|e| format!("create {}: {e}", out_path.display()))?;
        std::io::copy(&mut entry, &mut out).map_err(|e| format!("unpack {name}: {e}"))?;
        set_executable(&out_path)?;
    }
    Ok(())
}

fn extract_zip(archive: &Path, dest: &Path, bin_name: &str) -> Result<(), String> {
    let file = fs::File::open(archive).map_err(|e| format!("open archive: {e}"))?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| format!("read archive: {e}"))?;
    for index in 0..zip.len() {
        let mut entry = zip
            .by_index(index)
            .map_err(|e| format!("read archive entry: {e}"))?;
        if entry.is_dir() {
            continue;
        }
        let raw_name = entry.name().to_owned();
        let Some(name) = Path::new(&raw_name)
            .file_name()
            .and_then(|n| n.to_str())
            .map(str::to_owned)
        else {
            continue;
        };
        if !keep_entry(&name, bin_name) {
            continue;
        }
        let out_path = dest.join(&name);
        let mut out = fs::File::create(&out_path)
            .map_err(|e| format!("create {}: {e}", out_path.display()))?;
        std::io::copy(&mut entry, &mut out).map_err(|e| format!("unpack {name}: {e}"))?;
        set_executable(&out_path)?;
    }
    Ok(())
}

// Everything we keep is a binary or shared library; a blanket 755 is simpler
// and safer than trusting archive modes. No-op off unix (Windows has no exec
// bit).
#[cfg(unix)]
fn set_executable(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o755))
        .map_err(|e| format!("chmod {}: {e}", path.display()))
}

#[cfg(not(unix))]
fn set_executable(_path: &Path) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pins_match_fetch_script() {
        let script = include_str!("../../../scripts/fetch-llama-server.sh");
        let tag_line = script
            .lines()
            .find(|l| l.trim_start().starts_with("LLAMA_RELEASE_TAG="))
            .expect("fetch script defines LLAMA_RELEASE_TAG");
        let tag = tag_line.split('"').nth(1).expect("quoted tag");
        assert_eq!(tag, ENGINE_TAG, "release tag drifted from fetch script");

        // The script builds asset names as llama-${LLAMA_RELEASE_TAG}-bin-…;
        // require every pinned (triple, asset, sha) row to appear so neither
        // side can change without the other.
        assert_eq!(ENGINE_ASSETS.len(), 4, "four supported triples");
        for asset in ENGINE_ASSETS {
            assert!(
                script.contains(asset.triple),
                "fetch script lost triple {}",
                asset.triple
            );
            let script_asset = asset.asset.replace(
                &format!("llama-{ENGINE_TAG}-"),
                "llama-${LLAMA_RELEASE_TAG}-",
            );
            assert!(
                script.contains(&script_asset),
                "fetch script lost asset {script_asset}"
            );
            assert!(
                script.contains(asset.sha256),
                "sha256 for {} drifted from fetch script",
                asset.triple
            );
        }
    }

    #[test]
    fn parses_accelerator_devices_from_llama_output() {
        let output = r#"
Available devices:
  Vulkan0: NVIDIA GeForce RTX 4080 (16376 MiB, 15120 MiB free)
  Vulkan1: AMD Radeon RX 7800 XT (16368 MiB, 14200 MiB free)
  CPU: AMD Ryzen 9 7950X
"#;
        assert_eq!(
            parse_device_list(output),
            vec![
                EngineDevice {
                    id: "Vulkan0".to_string(),
                    label: "NVIDIA GeForce RTX 4080 (16376 MiB, 15120 MiB free)".to_string(),
                },
                EngineDevice {
                    id: "Vulkan1".to_string(),
                    label: "AMD Radeon RX 7800 XT (16368 MiB, 14200 MiB free)".to_string(),
                },
            ]
        );
    }

    #[test]
    fn device_parser_deduplicates_and_ignores_unusable_lines() {
        let output = "Vulkan0: First\nVulkan0: Duplicate\nno colon here\nCPU: Host\n: empty\n";
        assert_eq!(
            parse_device_list(output),
            vec![EngineDevice {
                id: "Vulkan0".to_string(),
                label: "First".to_string(),
            }]
        );
    }

    #[test]
    fn keeps_engine_binary_and_libs_only() {
        assert!(keep_entry("llama-server", "llama-server"));
        assert!(keep_entry("llama-server.exe", "llama-server.exe"));
        assert!(keep_entry("libllama.0.dylib", "llama-server"));
        assert!(keep_entry("ggml-cpu-haswell.dll", "llama-server.exe"));
        assert!(keep_entry("ggml-vulkan.dll", "llama-server.exe"));
        assert!(keep_entry("libllama.so", "llama-server"));
        assert!(keep_entry("libllama.so.0.0.9095", "llama-server"));
        assert!(keep_entry("LICENSE", "llama-server"));
        assert!(!keep_entry("llama-cli", "llama-server"));
        assert!(!keep_entry("llama-bench.exe", "llama-server.exe"));
        assert!(!keep_entry("README.md", "llama-server"));
    }

    fn scratch_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "studyvis-engine-test-{name}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn extracts_tar_gz_flattened_and_filtered() {
        let dir = scratch_dir("tar");
        let archive = dir.join("engine.tar.gz");
        {
            let file = fs::File::create(&archive).unwrap();
            let encoder = flate2::write::GzEncoder::new(file, flate2::Compression::default());
            let mut builder = tar::Builder::new(encoder);
            // (No `..` fixture here — tar::Builder itself refuses to write
            // such paths; the traversal case is covered by the zip test.)
            for (path, data) in [
                ("llama-b9095/llama-server", &b"engine-binary"[..]),
                ("llama-b9095/libllama.so.0", b"lib"),
                ("llama-b9095/llama-cli", b"unwanted tool"),
            ] {
                let mut header = tar::Header::new_gnu();
                header.set_size(data.len() as u64);
                header.set_mode(0o755);
                header.set_cksum();
                builder.append_data(&mut header, path, data).unwrap();
            }
            builder.into_inner().unwrap().finish().unwrap();
        }
        let out = dir.join("out");
        extract_archive(&archive, &out, "llama-server").unwrap();

        assert!(out.join("llama-server").is_file());
        assert!(out.join("libllama.so.0").is_file());
        assert!(!out.join("llama-cli").exists());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(out.join("llama-server"))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o111, 0o111, "binary must be executable");
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn extracts_zip_flattened_and_filtered() {
        let dir = scratch_dir("zip");
        let archive = dir.join("engine.zip");
        {
            let file = fs::File::create(&archive).unwrap();
            let mut writer = zip::ZipWriter::new(file);
            let options = zip::write::SimpleFileOptions::default();
            for (path, data) in [
                ("llama-server.exe", &b"engine-binary"[..]),
                ("ggml.dll", b"lib"),
                ("nested/dir/ggml-base.dll", b"flattened"),
                ("../evil-escape.dll", b"flattened, not escaped"),
                ("llama-bench.exe", b"unwanted tool"),
            ] {
                writer.start_file(path, options).unwrap();
                writer.write_all(data).unwrap();
            }
            writer.finish().unwrap();
        }
        let out = dir.join("out");
        extract_archive(&archive, &out, "llama-server.exe").unwrap();

        assert!(out.join("llama-server.exe").is_file());
        assert!(out.join("ggml.dll").is_file());
        assert!(out.join("ggml-base.dll").is_file());
        assert!(!out.join("llama-bench.exe").exists());
        assert!(!out.join("nested").exists());
        // The traversal-shaped entry lands INSIDE the staging dir, flattened.
        assert!(out.join("evil-escape.dll").is_file());
        assert!(!dir.join("evil-escape.dll").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn asset_table_covers_release_matrix() {
        assert!(asset_for("aarch64-apple-darwin").is_some());
        assert!(asset_for("x86_64-pc-windows-msvc").is_some());
        assert!(asset_for("x86_64-apple-darwin").is_some());
        assert!(asset_for("x86_64-unknown-linux-gnu").is_some());
        assert!(asset_for("aarch64-unknown-linux-gnu").is_none());
    }

    #[test]
    fn staged_engine_promotion_replaces_the_old_install() {
        let root = scratch_dir("promote");
        let staging = root.join("staging");
        let final_dir = root.join("final");
        fs::create_dir_all(&staging).unwrap();
        fs::create_dir_all(&final_dir).unwrap();
        fs::write(staging.join("llama-server"), b"new").unwrap();
        fs::write(final_dir.join("llama-server"), b"old").unwrap();

        promote_staged_install(&staging, &final_dir).expect("promote");

        assert!(!staging.exists());
        assert_eq!(fs::read(final_dir.join("llama-server")).unwrap(), b"new");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn failed_engine_promotion_restores_the_old_install() {
        let root = scratch_dir("rollback");
        let final_dir = root.join("final");
        let missing_staging = root.join("missing-staging");
        fs::create_dir_all(&final_dir).unwrap();
        fs::write(final_dir.join("llama-server"), b"old").unwrap();

        let err = promote_staged_install(&missing_staging, &final_dir)
            .expect_err("missing staging must fail");

        assert!(err.contains("previous engine restored"));
        assert_eq!(fs::read(final_dir.join("llama-server")).unwrap(), b"old");
        assert!(!rollback_dir_for(&final_dir).unwrap().exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn interrupted_engine_promotion_restores_the_old_install_before_retry() {
        let root = scratch_dir("interrupted-rollback");
        let final_dir = root.join("final");
        let rollback_dir = rollback_dir_for(&final_dir).unwrap();
        fs::create_dir_all(&rollback_dir).unwrap();
        fs::write(rollback_dir.join("llama-server"), b"old").unwrap();

        recover_interrupted_promotion(&final_dir).expect("restore interrupted install");

        assert_eq!(fs::read(final_dir.join("llama-server")).unwrap(), b"old");
        assert!(!rollback_dir.exists());
        let _ = fs::remove_dir_all(root);
    }
}
