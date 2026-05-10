use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::async_runtime::Mutex;
use tauri::{path::BaseDirectory, AppHandle, Manager, Runtime, State};
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
    errored: bool,
    last_error: Option<String>,
}

pub struct SidecarState(Arc<Mutex<SidecarInner>>);

impl SidecarState {
    pub fn new() -> Self {
        Self(Arc::new(Mutex::new(SidecarInner::default())))
    }

    // Synchronous shutdown used during app exit. Doesn't await the watcher;
    // the OS will reap the child once the parent process exits, but explicit
    // kill() unblocks any sockets immediately so a relaunch isn't ECONNREFUSED.
    pub fn kill_blocking<R: Runtime>(app: &AppHandle<R>) {
        let Some(state) = app.try_state::<SidecarState>() else {
            return;
        };
        let arc = state.0.clone();
        // Try to acquire without blocking the runtime; on contention skip,
        // since exit handlers shouldn't deadlock on a held lock.
        let Ok(mut guard) = arc.try_lock() else {
            return;
        };
        guard.generation = guard.generation.wrapping_add(1);
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
    // restarting on the upcoming Terminated event.
    guard.generation = guard.generation.wrapping_add(1);
    let child = guard.child.take();
    guard.port = None;
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
        let dir_str = dir.to_string_lossy();
        // Prepend the runtime directory to the platform's shared-library
        // search path so the prebuilt llama-server's @rpath / DT_RUNPATH
        // entries (which point at @loader_path / $ORIGIN) resolve the
        // companion libs Tauri places under Contents/Resources/. The
        // statically-linked build path (--shared not passed to
        // build-llama-server.sh) doesn't need this; the env var is harmless
        // in that case.
        #[cfg(target_os = "macos")]
        {
            command = command.env("DYLD_FALLBACK_LIBRARY_PATH", dir_str.as_ref());
        }
        #[cfg(target_os = "linux")]
        {
            command = command.env("LD_LIBRARY_PATH", dir_str.as_ref());
        }
        #[cfg(target_os = "windows")]
        {
            // Windows has no DYLD-style env; PATH is the DLL search path for
            // child processes. Prepend, preserving the existing PATH.
            let existing = std::env::var("PATH").unwrap_or_default();
            let combined = format!("{};{}", dir_str, existing);
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
        // Drop any leftover handle from this generation; the child is gone.
        guard.child = None;

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
