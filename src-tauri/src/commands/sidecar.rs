//! llama-server sidecar lifecycle: spawn on demand on `127.0.0.1:<random
//! port>`, crash-restart within a budget, and kill explicitly at exit.
//!
//! Lifecycle invariants (the highest-risk area in the Rust tree):
//! - `SidecarState::kill_blocking` is the ONLY thing that stops the process.
//!   Neither OS kills the child when the parent exits, and `CommandChild`
//!   does not kill on drop — every exit path (`RunEvent::Exit*` in `lib.rs`,
//!   `system_relaunch_app`) must reach it or a multi-GB llama-server outlives
//!   the app holding its port and model file.
//! - The `generation` counter + `shutting_down` flag (below) keep the
//!   crash-restart watcher honest: a stale watcher must never re-incarnate a
//!   process that a newer start or an exit already superseded.
//! - `TARGET_TRIPLE` / `SIDECAR_NAME` couple to `scripts/fetch-llama-server.sh`
//!   output and `tauri.conf.json`'s `externalBin` + `resources` globs.
//!
//! JS drives this via `sidecar_start` / `sidecar_stop` / `sidecar_status`
//! (`src/features/ai/sidecar.ts`) and talks to the spawned server directly
//! over OpenAI-compatible HTTP.

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::async_runtime::Mutex;
use tauri::{path::BaseDirectory, AppHandle, Manager, Runtime, State};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

use crate::db::data_dir;

// Rust target triple matches the suffix scripts/fetch-llama-server.sh writes
// to src-tauri/binaries/ and the path under bundle.resources where companion
// dylibs/dlls land. Update both the script and these arms in lockstep when
// adding a new platform.
#[cfg(all(target_arch = "aarch64", target_os = "macos"))]
const TARGET_TRIPLE: &str = "aarch64-apple-darwin";
#[cfg(all(target_arch = "x86_64", target_os = "macos"))]
const TARGET_TRIPLE: &str = "x86_64-apple-darwin";
#[cfg(all(target_arch = "x86_64", target_os = "windows"))]
const TARGET_TRIPLE: &str = "x86_64-pc-windows-msvc";
#[cfg(all(target_arch = "x86_64", target_os = "linux"))]
const TARGET_TRIPLE: &str = "x86_64-unknown-linux-gnu";

const SIDECAR_NAME: &str = "binaries/llama-server";
const LOG_DIR: &str = "logs";
const LOG_FILE: &str = "llama-server.log";
// Cap the diagnostic log at 5 MiB, keeping a single previous generation as
// `llama-server.log.1`. The magnitude is a judgement call: large enough to
// hold a long AI session's stdout/stderr, small enough to stay shareable via
// Settings → Advanced → Share log. Bounds total on-disk log to ~2× this.
const LOG_MAX_BYTES: u64 = 5 * 1024 * 1024;

// Restart policy: cap automatic respawns so a permanently broken binary
// doesn't spam the log file. After RESTART_BUDGET attempts inside
// RESTART_WINDOW, the watcher gives up and surfaces `errored = true`; the JS
// side then has to call sidecar_stop + sidecar_start to retry deliberately.
const RESTART_BUDGET: u32 = 3;
const RESTART_WINDOW: Duration = Duration::from_secs(30);
const RESTART_BACKOFF: Duration = Duration::from_millis(500);

#[derive(Default)]
struct SidecarInner {
    child: Option<CommandChild>,
    port: Option<u16>,
    model: Option<String>,
    mmproj: Option<String>,
    ctx_size: Option<u32>,
    // generation increments on every explicit start so a stale watcher from a
    // previous run knows to exit instead of re-incarnating the process.
    generation: u64,
    // Set once by kill_blocking at app exit / relaunch. The crash-restart
    // watcher re-checks this after its backoff sleep and bails BEFORE spawning,
    // so a sidecar that died in the restart window can't be respawned after the
    // exit path already ran kill_blocking (which would orphan it — the
    // post-spawn generation check only fires if the watcher task gets another
    // scheduling quantum before the process tears down).
    shutting_down: bool,
    errored: bool,
    last_error: Option<String>,
}

pub struct SidecarState(Arc<Mutex<SidecarInner>>);

impl SidecarState {
    pub fn new() -> Self {
        Self(Arc::new(Mutex::new(SidecarInner::default())))
    }

    // Synchronous shutdown used during app exit. This explicit kill is the
    // ONLY thing that stops the sidecar: neither Windows (no job object is
    // configured) nor macOS terminates a child when the parent exits, and
    // tauri-plugin-shell's CommandChild does not kill on drop — so without
    // this a multi-GB llama-server would outlive the app, holding its model
    // file and port until the user kills it by hand. The exit callback runs
    // on the main thread (not an async-runtime worker), so a brief bounded
    // spin to acquire the lock is safe and avoids skipping the kill on lock
    // contention; the bound keeps a wedged holder from hanging quit.
    pub fn kill_blocking<R: Runtime>(app: &AppHandle<R>) {
        let Some(state) = app.try_state::<SidecarState>() else {
            return;
        };
        let arc = state.0.clone();
        let deadline = Instant::now() + Duration::from_millis(500);
        let mut guard = loop {
            match arc.try_lock() {
                Ok(g) => break g,
                Err(_) => {
                    if Instant::now() >= deadline {
                        return;
                    }
                    std::thread::sleep(Duration::from_millis(10));
                }
            }
        };
        guard.generation = guard.generation.wrapping_add(1);
        guard.shutting_down = true;
        if let Some(child) = guard.child.take() {
            let _ = child.kill();
        }
        guard.port = None;
    }
}

#[derive(Serialize)]
pub struct SidecarStatus {
    pub running: bool,
    pub port: Option<u16>,
    pub model: Option<String>,
    pub mmproj: Option<String>,
    pub ctx_size: Option<u32>,
    pub errored: bool,
    pub last_error: Option<String>,
}

#[tauri::command]
pub async fn sidecar_start<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, SidecarState>,
    model_path: String,
    mmproj_path: Option<String>,
    ctx_size: u32,
) -> Result<u16, String> {
    let arc = state.0.clone();
    let mut guard = arc.lock().await;
    if guard.child.is_some() {
        return guard
            .port
            .ok_or_else(|| "sidecar running but no port recorded".to_string());
    }

    if !PathBuf::from(&model_path).is_file() {
        return Err(format!("model_path does not exist: {model_path}"));
    }
    if let Some(p) = mmproj_path.as_ref() {
        if !PathBuf::from(p).is_file() {
            return Err(format!("mmproj_path does not exist: {p}"));
        }
    }

    let port = pick_unused_port()?;
    guard.generation = guard.generation.wrapping_add(1);
    let generation = guard.generation;
    let runtime_dir = resolve_runtime_dir(&app)?;
    let log_path = ensure_log_path(&app)?;
    // Roll the log before opening for append, while it has no open writer (only
    // one sidecar runs at a time). Keeps the diagnostic log size-bounded (D7).
    rotate_log_if_needed(&log_path, LOG_MAX_BYTES);

    let (rx, child) = spawn_llama(
        &app,
        &model_path,
        mmproj_path.as_deref(),
        ctx_size,
        port,
        runtime_dir.as_deref(),
    )?;
    let log_file = open_log_file(&log_path)?;

    guard.child = Some(child);
    guard.port = Some(port);
    guard.model = Some(model_path.clone());
    guard.mmproj = mmproj_path.clone();
    guard.ctx_size = Some(ctx_size);
    guard.errored = false;
    guard.last_error = None;
    drop(guard);

    let app_for_watcher = app.clone();
    let state_arc = arc.clone();
    let model_for_restart = model_path;
    let mmproj_for_restart = mmproj_path;
    tauri::async_runtime::spawn(async move {
        watch(
            app_for_watcher,
            state_arc,
            rx,
            log_file,
            generation,
            model_for_restart,
            mmproj_for_restart,
            ctx_size,
        )
        .await;
    });

    Ok(port)
}

#[tauri::command]
pub async fn sidecar_stop(state: State<'_, SidecarState>) -> Result<(), String> {
    let arc = state.0.clone();
    let mut guard = arc.lock().await;
    // Bumping the generation tells the in-flight watcher to exit instead of
    // restarting on the upcoming Terminated event. We wipe every field
    // sidecar_status reports so a follow-up status() doesn't return stale
    // model/mmproj metadata while running=false.
    guard.generation = guard.generation.wrapping_add(1);
    let child = guard.child.take();
    guard.port = None;
    guard.model = None;
    guard.mmproj = None;
    guard.ctx_size = None;
    guard.errored = false;
    guard.last_error = None;
    drop(guard);
    if let Some(child) = child {
        child
            .kill()
            .map_err(|e| format!("kill llama-server: {e}"))?;
    }
    Ok(())
}

#[tauri::command]
pub async fn sidecar_status(state: State<'_, SidecarState>) -> Result<SidecarStatus, String> {
    let arc = state.0.clone();
    let guard = arc.lock().await;
    Ok(SidecarStatus {
        running: guard.child.is_some(),
        port: guard.port,
        model: guard.model.clone(),
        mmproj: guard.mmproj.clone(),
        ctx_size: guard.ctx_size,
        errored: guard.errored,
        last_error: guard.last_error.clone(),
    })
}

#[derive(Serialize)]
pub struct DiagnosticsInfo {
    pub os: String,
    pub arch: String,
    pub log_path: String,
}

// Reveal the AI diagnostic log in the OS file manager so a user can attach it
// to a bug report (PLAN §3 "Share Log"). The log file is absent until the
// sidecar runs once, so fall back to revealing its parent dir, which
// ensure_log_path creates. Strictly local — nothing is uploaded.
#[tauri::command]
pub fn diagnostics_reveal_log<R: Runtime>(app: AppHandle<R>) -> Result<String, String> {
    let log_path = ensure_log_path(&app)?;
    let reveal_target = if log_path.is_file() {
        log_path.clone()
    } else {
        log_path
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| log_path.clone())
    };
    let reveal_str = reveal_target.to_string_lossy().into_owned();
    app.opener()
        .reveal_item_in_dir(&reveal_str)
        .map_err(|e| e.to_string())?;
    Ok(log_path.to_string_lossy().into_owned())
}

// Plaintext diagnostics for a manual bug report. Deliberately PII-free: OS,
// arch, and the log path only — no pubkey, display name, friends, or mnemonic.
// The app version is added JS-side from __APP_VERSION__.
#[tauri::command]
pub fn diagnostics_info<R: Runtime>(app: AppHandle<R>) -> Result<DiagnosticsInfo, String> {
    let log_path = ensure_log_path(&app)?;
    Ok(DiagnosticsInfo {
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        log_path: log_path.to_string_lossy().into_owned(),
    })
}

fn pick_unused_port() -> Result<u16, String> {
    // Bind to 0 to let the OS hand us an ephemeral port, then drop the listener
    // and pass the same number to llama-server. There's a tiny TOCTOU window
    // where another process can claim the port before llama-server binds —
    // acceptable for the friends-only target audience.
    let listener =
        TcpListener::bind("127.0.0.1:0").map_err(|e| format!("pick_unused_port: bind: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("pick_unused_port: local_addr: {e}"))?
        .port();
    drop(listener);
    Ok(port)
}

fn resolve_runtime_dir<R: Runtime>(app: &AppHandle<R>) -> Result<Option<PathBuf>, String> {
    // Path matches scripts/fetch-llama-server.sh layout. Tauri 2 resolves
    // BaseDirectory::Resource against the bundle's Contents/Resources/ in
    // production and against src-tauri/ in dev. We tolerate the directory
    // missing — that's the static-build case (single binary, no companions).
    let rel = format!("binaries/llama-runtime-{}", TARGET_TRIPLE);
    match app.path().resolve(&rel, BaseDirectory::Resource) {
        Ok(p) if p.is_dir() => Ok(Some(p)),
        _ => Ok(None),
    }
}

fn ensure_log_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let dir = data_dir(app)?.join(LOG_DIR);
    fs::create_dir_all(&dir).map_err(|e| format!("create log dir: {e}"))?;
    Ok(dir.join(LOG_FILE))
}

fn open_log_file(path: &PathBuf) -> Result<File, String> {
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|e| format!("open log file {}: {e}", path.display()))
}

fn should_rotate(current_len: u64, max_bytes: u64) -> bool {
    current_len >= max_bytes
}

// Single-generation roll: when the live log has reached the cap, move it to
// `<name>.1` (overwriting any prior generation). Best-effort — a failed
// metadata read or rename must never block the AI session, so errors are
// swallowed; the worst case is the prior unbounded-append behaviour.
fn rotate_log_if_needed(path: &Path, max_bytes: u64) {
    let Ok(meta) = fs::metadata(path) else {
        return;
    };
    if !should_rotate(meta.len(), max_bytes) {
        return;
    }
    let rolled = path.with_extension("log.1");
    let _ = fs::rename(path, rolled);
}

fn spawn_llama<R: Runtime>(
    app: &AppHandle<R>,
    model_path: &str,
    mmproj_path: Option<&str>,
    ctx_size: u32,
    port: u16,
    runtime_dir: Option<&Path>,
) -> Result<(tauri::async_runtime::Receiver<CommandEvent>, CommandChild), String> {
    let mut command = app
        .shell()
        .sidecar(SIDECAR_NAME)
        .map_err(|e| format!("locate sidecar {SIDECAR_NAME}: {e}"))?
        .args([
            "--host",
            "127.0.0.1",
            "--port",
            &port.to_string(),
            "--ctx-size",
            &ctx_size.to_string(),
            "--n-gpu-layers",
            "0",
            "--model",
            model_path,
        ]);
    if let Some(p) = mmproj_path {
        command = command.args(["--mmproj", p]);
    }
    if let Some(dir) = runtime_dir {
        let dir_str = dir.to_string_lossy().into_owned();
        // Prepend the runtime directory to the platform's shared-library
        // search path so the prebuilt llama-server's @rpath / DT_RUNPATH
        // entries (which point at @loader_path / $ORIGIN) resolve the
        // companion libs Tauri places under Contents/Resources/. The
        // statically-linked build path (--shared not passed to
        // build-llama-server.sh) doesn't need this; the env var is harmless
        // in that case. Always prepend rather than overwrite — if the user
        // already set DYLD_FALLBACK_LIBRARY_PATH / LD_LIBRARY_PATH for some
        // unrelated reason, blowing it away could break the child's
        // resolution of transitive deps.
        #[cfg(target_os = "macos")]
        {
            const KEY: &str = "DYLD_FALLBACK_LIBRARY_PATH";
            let combined = match std::env::var(KEY) {
                Ok(prev) if !prev.is_empty() => format!("{}:{}", dir_str, prev),
                _ => dir_str,
            };
            command = command.env(KEY, combined);
        }
        #[cfg(target_os = "linux")]
        {
            const KEY: &str = "LD_LIBRARY_PATH";
            let combined = match std::env::var(KEY) {
                Ok(prev) if !prev.is_empty() => format!("{}:{}", dir_str, prev),
                _ => dir_str,
            };
            command = command.env(KEY, combined);
        }
        #[cfg(target_os = "windows")]
        {
            // Windows has no DYLD-style env; PATH is the DLL search path for
            // child processes. Always prepend so the existing PATH wins for
            // unrelated tooling reachable by the sidecar.
            let combined = match std::env::var("PATH") {
                Ok(prev) if !prev.is_empty() => format!("{};{}", dir_str, prev),
                _ => dir_str,
            };
            command = command.env("PATH", combined);
        }
    }
    command
        .spawn()
        .map_err(|e| format!("spawn llama-server: {e}"))
}

async fn watch<R: Runtime>(
    app: AppHandle<R>,
    state: Arc<Mutex<SidecarInner>>,
    mut rx: tauri::async_runtime::Receiver<CommandEvent>,
    log_file: File,
    generation: u64,
    model_path: String,
    mmproj_path: Option<String>,
    ctx_size: u32,
) {
    let mut log = log_file;
    let mut restart_attempts: u32 = 0;
    let mut window_started_at: Option<Instant> = None;

    loop {
        let mut last_exit: Option<String> = None;
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => {
                    let _ = log.write_all(b"[stdout] ");
                    let _ = log.write_all(&bytes);
                    let _ = log.write_all(b"\n");
                }
                CommandEvent::Stderr(bytes) => {
                    let _ = log.write_all(b"[stderr] ");
                    let _ = log.write_all(&bytes);
                    let _ = log.write_all(b"\n");
                }
                CommandEvent::Terminated(payload) => {
                    let _ = writeln!(log, "[event] terminated code={:?}", payload.code);
                    last_exit = Some(format!("exit {:?}", payload.code));
                    break;
                }
                CommandEvent::Error(err) => {
                    let _ = writeln!(log, "[event] error: {err}");
                    last_exit = Some(err);
                    break;
                }
                _ => {}
            }
        }
        let _ = log.flush();

        // If a stop or a newer start happened while we were running, this
        // generation is stale — exit without restarting.
        let mut guard = state.lock().await;
        if guard.generation != generation {
            return;
        }
        // Drop the dead child handle and forget the port immediately so a
        // sidecar_status() inside the restart-backoff window can't claim
        // running=false while still reporting the now-bound-by-nobody port.
        // The new port is recorded only after a successful respawn below.
        guard.child = None;
        guard.port = None;

        // Track restart attempts within RESTART_WINDOW.
        let now = Instant::now();
        match window_started_at {
            Some(start) if now.duration_since(start) <= RESTART_WINDOW => {
                restart_attempts += 1;
            }
            _ => {
                window_started_at = Some(now);
                restart_attempts = 1;
            }
        }
        if restart_attempts > RESTART_BUDGET {
            guard.errored = true;
            guard.last_error = last_exit
                .clone()
                .or_else(|| Some(format!("restart budget exceeded ({RESTART_BUDGET})")));
            guard.port = None;
            let _ = writeln!(
                log,
                "[event] giving up after {restart_attempts} restart attempts"
            );
            let _ = log.flush();
            return;
        }
        drop(guard);

        // Avoid taking a direct dep on `tokio::time` — tauri 2's tokio
        // re-export doesn't necessarily enable the `time` feature. A blocking
        // sleep on a worker thread is fine for the half-second backoff.
        let _ = tauri::async_runtime::spawn_blocking(|| {
            std::thread::sleep(RESTART_BACKOFF);
        })
        .await;

        // Re-check after the backoff: an explicit stop, a newer start, or an
        // app-exit/relaunch kill_blocking during the sleep means we must not
        // respawn. Bailing BEFORE pick_unused_port/spawn_llama is what keeps a
        // sidecar that crashed in the restart window from being orphaned at
        // quit time (kill_blocking already ran; it found no child to kill).
        {
            let guard = state.lock().await;
            if guard.generation != generation || guard.shutting_down {
                return;
            }
        }

        let port = match pick_unused_port() {
            Ok(p) => p,
            Err(e) => {
                let mut guard = state.lock().await;
                if guard.generation != generation {
                    return;
                }
                guard.errored = true;
                guard.last_error = Some(e.clone());
                guard.port = None;
                let _ = writeln!(log, "[event] pick_unused_port failed: {e}");
                let _ = log.flush();
                return;
            }
        };
        let runtime_dir = match resolve_runtime_dir(&app) {
            Ok(d) => d,
            Err(_) => None,
        };
        let spawn_result = spawn_llama(
            &app,
            &model_path,
            mmproj_path.as_deref(),
            ctx_size,
            port,
            runtime_dir.as_deref(),
        );
        let (new_rx, new_child) = match spawn_result {
            Ok(pair) => pair,
            Err(e) => {
                let mut guard = state.lock().await;
                if guard.generation != generation {
                    return;
                }
                guard.errored = true;
                guard.last_error = Some(e.clone());
                guard.port = None;
                let _ = writeln!(log, "[event] respawn failed: {e}");
                let _ = log.flush();
                return;
            }
        };
        let mut guard = state.lock().await;
        if guard.generation != generation {
            // Another start replaced us in the gap; let our spawned child die.
            let _ = new_child.kill();
            return;
        }
        let _ = writeln!(log, "[event] respawned on port {port}");
        let _ = log.flush();
        guard.child = Some(new_child);
        guard.port = Some(port);
        drop(guard);
        rx = new_rx;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rotates_at_or_above_cap() {
        assert!(should_rotate(LOG_MAX_BYTES, LOG_MAX_BYTES));
        assert!(should_rotate(LOG_MAX_BYTES + 1, LOG_MAX_BYTES));
    }

    #[test]
    fn keeps_small_log() {
        assert!(!should_rotate(0, LOG_MAX_BYTES));
        assert!(!should_rotate(LOG_MAX_BYTES - 1, LOG_MAX_BYTES));
    }
}
