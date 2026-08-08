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
//! - `TARGET_TRIPLE` couples to `scripts/fetch-llama-server.sh` output and
//!   `tauri.conf.json`'s `externalBin` + `resources` globs.
//! - I73: the binary is resolved to an absolute path by
//!   `engine::resolve_candidates` and spawned via `shell().command()`. The
//!   old `shell().sidecar("binaries/llama-server")` call resolved
//!   `<exe_dir>/binaries/llama-server`, but tauri-build and the bundler both
//!   strip the directory prefix and place the file at `<exe_dir>/llama-server`
//!   — every in-app spawn failed with ENOENT since V2-P1. When no candidate
//!   resolves, `sidecar_start` auto-installs the pinned engine (settings-gated)
//!   before erroring.
//!
//! JS drives this via `sidecar_start` / `sidecar_stop` / `sidecar_status`
//! (`src/features/ai/sidecar.ts`) and talks to the spawned server directly
//! over OpenAI-compatible HTTP.

use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex, MutexGuard};
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
// dylibs/dlls land. tauri_build::build() emits this from cargo's TARGET, so it
// always names the triple actually being built. The hand-written #[cfg] arms
// this replaces left the const undefined on any unlisted triple (aarch64
// Linux, the dev host) — an E0425 raised far from its cause. The build-time
// gate is softer since I73: build.rs writes a placeholder for debug-profile
// builds (release-profile builds still fail outright when
// binaries/llama-server-<triple> is missing).
pub(crate) const TARGET_TRIPLE: &str = env!("TAURI_ENV_TARGET_TRIPLE");

// Exact-match sentinel for the JS side (mirrors ERR_AI_DISABLED in
// src/features/ai/sidecar.ts): no engine candidate resolves and auto-install
// is off, so the UI should show the calm not-installed state, not a crash.
pub(crate) const ENGINE_NOT_INSTALLED: &str = "engine_not_installed";

const LOG_DIR: &str = "logs";
pub(crate) const SIDECAR_LOG_FILE: &str = "llama-server.log";
const SIDECAR_LOG_MAX_BYTES: u64 = 5 * 1024 * 1024;
const RETAINED_TAIL_MARKER: &[u8] = b"[older engine output truncated]\n";

// The watcher writes while diagnostics may snapshot the file. Each critical
// section is synchronous and short; the async task never holds this over an
// await.
static SIDECAR_LOG_LOCK: StdMutex<()> = StdMutex::new(());

pub(crate) fn sidecar_log_guard() -> MutexGuard<'static, ()> {
    SIDECAR_LOG_LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

// Restart policy: cap automatic respawns so a permanently broken binary
// doesn't spam the log file. `restart_attempts` counts CONSECUTIVE respawns
// that each died before reaching MIN_HEALTHY_UPTIME; a child that ran at least
// that long is treated as a durable server and resets the streak, so a sidecar
// that self-heals after a long clean run is never starved. Once more than
// RESTART_BUDGET such short-lived children pile up (four in a row), the watcher
// gives up and surfaces `errored = true`; the JS side then has to call
// sidecar_stop + sidecar_start to retry deliberately. MIN_HEALTHY_UPTIME must
// comfortably exceed worst-case model load (a 7B Q4 off a cold disk) so a
// broken model that dies just after loading still trips the budget.
const RESTART_BUDGET: u32 = 3;
const MIN_HEALTHY_UPTIME: Duration = Duration::from_secs(120);
const RESTART_BACKOFF: Duration = Duration::from_millis(500);
// I83 — a lifetime ceiling on respawns within one generation, because the
// consecutive-streak rule above has a hole: a child that dies every ~2.5
// minutes clears MIN_HEALTHY_UPTIME every time, so `restart_attempts` resets to
// 1 forever and `errored` is never set. The JS stall notice fires once and the
// session then runs for an hour on an engine that is dying and respawning the
// whole time, recording nothing. This counts EVERY respawn in the generation,
// not just the sub-uptime ones, or a 121-second cycle would escape it again.
//
// 12 is chosen so the two cases stay far apart: a genuinely long session whose
// sidecar dies once an hour after clean uptime spends 8 respawns across 8 hours
// and never trips, while a 121-second crash cycle trips at roughly 24 minutes.
// An explicit sidecar_stop + sidecar_start bumps the generation, so a
// deliberate retry always starts from zero.
const TOTAL_RESTART_BUDGET: u32 = 12;

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
    engine: State<'_, super::engine::EngineState>,
    model_path: String,
    mmproj_path: Option<String>,
    ctx_size: u32,
    engine_auto_install: bool,
) -> Result<u16, String> {
    let arc = state.0.clone();
    {
        let guard = arc.lock().await;
        if guard.child.is_some() {
            return guard
                .port
                .ok_or_else(|| "sidecar running but no port recorded".to_string());
        }
    }

    if !PathBuf::from(&model_path).is_file() {
        return Err(format!("model_path does not exist: {model_path}"));
    }
    if let Some(p) = mmproj_path.as_ref() {
        if !PathBuf::from(p).is_file() {
            return Err(format!("mmproj_path does not exist: {p}"));
        }
    }

    // Engine presence check OUTSIDE the sidecar lock: a first-run download
    // takes a while and sidecar_status polls must stay responsive. The
    // engine module serializes concurrent installs itself.
    if super::engine::resolve_candidates(&app).is_empty() {
        if !engine_auto_install {
            return Err(ENGINE_NOT_INSTALLED.to_string());
        }
        super::engine::ensure_installed(&app, &engine)
            .await
            .map_err(|e| format!("engine install: {e}"))?;
    }

    // Hold the install gate across resolve + spawn so a concurrent forced
    // reinstall (engine_install) can't swap the managed engine dir under the
    // child we're about to spawn (PR-88 review). The ONE lock-order invariant
    // across both modules: engine gate before sidecar lock, never the
    // reverse. engine_install honors it (gate, then stop_now — which takes
    // and RELEASES the sidecar lock internally and never touches the gate);
    // holding a sidecar guard while acquiring the gate anywhere would be an
    // AB-BA deadlock with this function. ensure_installed above takes and
    // releases the gate internally, so it must stay before this acquire.
    let _engine_gate = engine.gate.lock().await;

    let mut guard = arc.lock().await;
    // Re-check after the unlocked window — a concurrent start may have won.
    if guard.child.is_some() {
        return guard
            .port
            .ok_or_else(|| "sidecar running but no port recorded".to_string());
    }
    if guard.shutting_down {
        return Err("app is shutting down".to_string());
    }

    let port = pick_unused_port()?;
    guard.generation = guard.generation.wrapping_add(1);
    let generation = guard.generation;
    let log_path = ensure_log_path(&app)?;
    // One sidecar generation corresponds to one explicit AI-engine run. Archive
    // the previous run before opening this one, retaining ten generations.
    // Benchmarks and deliberate restarts count as runs too, so the UI calls
    // these "log generations" rather than claiming they are exactly sessions.
    let mut log_file = {
        let _log_guard = sidecar_log_guard();
        let _ = rotate_sidecar_log_history(
            &log_path,
            crate::commands::applog::LOG_HISTORY_FILES,
            SIDECAR_LOG_MAX_BYTES,
        );
        open_log_file(&log_path)?
    };
    with_sidecar_log(|| {
        let _ = writeln!(
            log_file,
            "[event gen={generation}] start target={TARGET_TRIPLE} ctx={ctx_size} mmproj={} gpu_layers={N_GPU_LAYERS}",
            mmproj_path.is_some()
        );
        let _ = log_file.flush();
    });

    let (rx, child) =
        spawn_with_fallback(&app, &model_path, mmproj_path.as_deref(), ctx_size, port)?;

    guard.child = Some(child);
    guard.port = Some(port);
    guard.model = Some(model_path.clone());
    guard.mmproj = mmproj_path.clone();
    guard.ctx_size = Some(ctx_size);
    guard.errored = false;
    guard.last_error = None;
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
    drop(guard);

    Ok(port)
}

// Bumping the generation tells the in-flight watcher to exit instead of
// restarting on the upcoming Terminated event. We wipe every field
// sidecar_status reports so a follow-up status() doesn't return stale
// model/mmproj metadata while running=false. Shared by sidecar_stop and the
// model_remove serving-check so the two teardown paths can't drift.
fn take_child_and_wipe(guard: &mut SidecarInner) -> Option<CommandChild> {
    guard.generation = guard.generation.wrapping_add(1);
    let child = guard.child.take();
    guard.port = None;
    guard.model = None;
    guard.mmproj = None;
    guard.ctx_size = None;
    guard.errored = false;
    guard.last_error = None;
    child
}

// Shared by sidecar_stop and engine_install (a reinstall must not race a
// running child — Windows can't replace loaded DLLs).
pub(crate) async fn stop_now(state: &SidecarState) -> Result<(), String> {
    let arc = state.0.clone();
    let mut guard = arc.lock().await;
    let child = take_child_and_wipe(&mut guard);
    drop(guard);
    if let Some(child) = child {
        child
            .kill()
            .map_err(|e| format!("kill llama-server: {e}"))?;
    }
    Ok(())
}

#[tauri::command]
pub async fn sidecar_stop(state: State<'_, SidecarState>) -> Result<(), String> {
    stop_now(&state).await
}

// model_remove's pre-delete check: when the running sidecar is serving a
// file under `dir` (its model or mmproj — both recorded at spawn), stop it
// first and report true. The check lives in Rust because SidecarInner is the
// truth about the child process — the JS sidecar store can lag the
// crash-restart watcher's respawns. Paths compare via starts_with on the
// same model_dir-built prefix the spawn path came from (no canonicalize: the
// dir is about to be deleted, and Windows canonicalize returns \\?\-prefixed
// paths that would break the comparison). An advanced user's custom GGUF
// outside the models root never matches, by design.
pub async fn stop_if_serving_under(state: &SidecarState, dir: &Path) -> Result<bool, String> {
    let arc = state.0.clone();
    let mut guard = arc.lock().await;
    let serving = guard
        .model
        .iter()
        .chain(guard.mmproj.iter())
        .any(|p| Path::new(p).starts_with(dir));
    if !serving {
        return Ok(false);
    }
    let child = take_child_and_wipe(&mut guard);
    drop(guard);
    if let Some(child) = child {
        child
            .kill()
            .map_err(|e| format!("kill llama-server: {e}"))?;
    }
    Ok(true)
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
    pub app_log_path: String,
}

// Reveal the diagnostic logs in the OS file manager so a user can attach them
// to a bug report (PLAN §3 "Share Log"). Prefers the app log (#98), which
// exists from the first launch and covers the whole app rather than only the
// AI sidecar; revealing a file opens its folder with the file selected, so the
// friend sees llama-server.log sitting beside it either way. Falls back to the
// sidecar log and then to the parent dir, which ensure_log_path creates.
// Strictly local — nothing is uploaded.
#[tauri::command]
pub fn diagnostics_reveal_log<R: Runtime>(app: AppHandle<R>) -> Result<String, String> {
    let log_path = crate::commands::applog::app_log_path(&app)
        .ok()
        .filter(|p| p.is_file())
        .map_or_else(|| ensure_log_path(&app), Ok)?;
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

// Plaintext diagnostics for a manual bug report. This struct carries OS, arch
// and the two log paths only — no pubkey, display name, friends, or mnemonic.
// The app version is added JS-side from __APP_VERSION__, and the log tail the
// clipboard blob appends was redacted at record time by src/lib/log.ts (the
// paths themselves go through the same scrubber, which takes the OS username
// out of them).
#[tauri::command]
pub fn diagnostics_info<R: Runtime>(app: AppHandle<R>) -> Result<DiagnosticsInfo, String> {
    let log_path = ensure_log_path(&app)?;
    let app_log_path = crate::commands::applog::app_log_path(&app)?;
    Ok(DiagnosticsInfo {
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        log_path: log_path.to_string_lossy().into_owned(),
        app_log_path: app_log_path.to_string_lossy().into_owned(),
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
    Ok(dir.join(SIDECAR_LOG_FILE))
}

fn open_log_file(path: &PathBuf) -> Result<File, String> {
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|e| format!("open log file {}: {e}", path.display()))
}

fn read_retained_tail(path: &Path, max_bytes: u64) -> Result<Vec<u8>, String> {
    let mut file = File::open(path).map_err(|e| format!("open retained log: {e}"))?;
    let length = file
        .metadata()
        .map_err(|e| format!("stat retained log: {e}"))?
        .len();
    if length <= max_bytes {
        let mut contents = Vec::with_capacity(length as usize);
        file.read_to_end(&mut contents)
            .map_err(|e| format!("read retained log: {e}"))?;
        return Ok(contents);
    }

    let marker_bytes = (RETAINED_TAIL_MARKER.len() as u64).min(max_bytes);
    let body_bytes = max_bytes.saturating_sub(marker_bytes);
    file.seek(SeekFrom::Start(length - body_bytes))
        .map_err(|e| format!("seek retained log: {e}"))?;
    let mut tail = Vec::with_capacity(max_bytes as usize);
    file.read_to_end(&mut tail)
        .map_err(|e| format!("read retained log: {e}"))?;
    if let Some(newline) = tail.iter().position(|byte| *byte == b'\n') {
        tail.drain(..=newline);
    } else {
        tail.clear();
    }
    let mut contents = RETAINED_TAIL_MARKER[..marker_bytes as usize].to_vec();
    contents.extend_from_slice(&tail);
    Ok(contents)
}

// The previous watcher can still own an open Windows handle briefly after
// sidecar_stop. Snapshot + truncate the live file instead of renaming it:
// the write mutex makes the snapshot line-consistent, and append-mode handles
// continue safely at the new end if a final termination event arrives later.
fn rotate_sidecar_log_history(
    path: &Path,
    generations: usize,
    max_bytes: u64,
) -> Result<(), String> {
    if generations == 0 || !path.is_file() {
        return Ok(());
    }
    let contents = read_retained_tail(path, max_bytes)?;
    crate::commands::applog::shift_log_history(path, generations);
    let first = crate::commands::applog::rotated_log_path(path, 1);
    let temp = path.with_extension("log.rotation.tmp");
    fs::write(&temp, contents).map_err(|e| format!("write retained log: {e}"))?;
    let _ = fs::remove_file(&first);
    fs::rename(&temp, &first).map_err(|e| format!("install retained log: {e}"))?;
    OpenOptions::new()
        .write(true)
        .truncate(true)
        .open(path)
        .map_err(|e| format!("truncate live log: {e}"))?;
    Ok(())
}

fn with_sidecar_log<T>(write: impl FnOnce() -> T) -> T {
    let _guard = sidecar_log_guard();
    write()
}

// #47 D2 — Metal offload on Apple Silicon. The bundled macos-arm64 llama.cpp
// b9095 build is Metal-enabled (scripts/build-llama-server.sh sets
// -DGGML_METAL=ON), yet inference ran CPU-only via an unconditional
// "--n-gpu-layers 0" — a direct contributor to the 2–30s p95 latencies in
// ARCHITECTURE §8 and the heat the cadence-backoff machinery exists to
// absorb. 99 offloads every layer of the 2–7B catalog models (verified on an
// M2: 27/27 layers offloaded, Metal init clean). The win-cpu-x64 prebuild has
// no GPU backend, so 0 stays there. If GPU contention with the WebRTC tiles
// ever materializes, gate this behind a Settings → AI toggle rather than
// reverting to CPU-only for everyone.
//
// Changing this value changes measured inference speed: bump
// INFERENCE_ENGINE_FINGERPRINT in src/features/ai/benchmark.ts so persisted
// benchmarks read as stale and users get the re-measure hint.
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
const N_GPU_LAYERS: &str = "99";
#[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
const N_GPU_LAYERS: &str = "0";

// Try every resolved engine binary in preference order (bundled, then
// managed). A bundled binary that fails to spawn — deleted, wrong arch,
// truncated — falls through to the managed install instead of surfacing an
// error; the fallback covers spawn failures only, a binary that starts and
// then crash-loops still ends at the watcher's restart budget.
fn spawn_with_fallback<R: Runtime>(
    app: &AppHandle<R>,
    model_path: &str,
    mmproj_path: Option<&str>,
    ctx_size: u32,
    port: u16,
) -> Result<(tauri::async_runtime::Receiver<CommandEvent>, CommandChild), String> {
    let candidates = super::engine::resolve_candidates(app);
    if candidates.is_empty() {
        return Err(ENGINE_NOT_INSTALLED.to_string());
    }
    let mut last_err = String::new();
    for (source, binary) in candidates {
        let runtime_dir = match source {
            // Companion dylibs/dlls that tauri bundles under Resources/.
            //
            // I83 — fall back to the binary's own directory when the resource
            // path doesn't resolve. `resolve_runtime_dir` returns Ok(None) for
            // any miss (wrong triple, bundler laid the companions out
            // differently — I73 is precisely that having happened once), and a
            // None used to mean spawning with NO working directory and NO PATH
            // prepend: the exact state I75 fixed, still reachable, and fatal on
            // Windows where the ggml backends are dlopen-only. The exe's own
            // directory is one of the two places ggml_backend_load_best globs
            // anyway, so this fallback is never worse than None and is right
            // whenever the companions ship beside the binary.
            super::engine::EngineSource::Bundled => resolve_runtime_dir(app)
                .ok()
                .flatten()
                .or_else(|| binary.parent().map(Path::to_path_buf)),
            // The managed install keeps libraries next to the binary, where
            // @loader_path / $ORIGIN already resolve them; prepending the dir
            // anyway keeps both sources on one code path.
            super::engine::EngineSource::Managed => binary.parent().map(Path::to_path_buf),
        };
        match spawn_llama(
            app,
            &binary,
            model_path,
            mmproj_path,
            ctx_size,
            port,
            runtime_dir.as_deref(),
        ) {
            Ok(pair) => return Ok(pair),
            Err(e) => last_err = e,
        }
    }
    Err(append_windows_dll_hint(last_err))
}

// llama-server.exe links msvcp140/vcruntime140 (the VC++ redistributable,
// not shipped in the llama.cpp zip and not an OS component). When a spawn
// fails on a machine without it, name the actual fix instead of leaving a
// bare CreateProcess error.
#[cfg(target_os = "windows")]
fn append_windows_dll_hint(err: String) -> String {
    // I83 — probe BOTH halves of the redistributable. llama-server.exe links
    // the C++ standard library (msvcp140.dll) as well as the C runtime
    // (vcruntime140.dll), and a machine can carry one without the other: some
    // installers ship vcruntime140 alone, and a repair/uninstall can leave a
    // partial set. Checking only vcruntime140 meant the actionable hint stayed
    // silent on exactly the boxes that needed it most.
    let sysroot = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".to_string());
    let system32 = Path::new(&sysroot).join("System32");
    let both_present =
        system32.join("vcruntime140.dll").exists() && system32.join("msvcp140.dll").exists();
    if both_present {
        err
    } else {
        format!(
            "{err}; the Microsoft Visual C++ runtime is missing or incomplete — install it from https://aka.ms/vs/17/release/vc_redist.x64.exe and try again"
        )
    }
}

#[cfg(not(target_os = "windows"))]
fn append_windows_dll_hint(err: String) -> String {
    err
}

fn spawn_llama<R: Runtime>(
    app: &AppHandle<R>,
    binary: &Path,
    model_path: &str,
    mmproj_path: Option<&str>,
    ctx_size: u32,
    port: u16,
    runtime_dir: Option<&Path>,
) -> Result<(tauri::async_runtime::Receiver<CommandEvent>, CommandChild), String> {
    // shell().command() with an absolute path — Command::new sets the same
    // piped stdio + CREATE_NO_WINDOW as the sidecar constructor, minus the
    // exe-relative resolution that I73 showed never matched where the binary
    // actually lands.
    let mut command = app.shell().command(binary).args([
        "--host",
        "127.0.0.1",
        "--port",
        &port.to_string(),
        "--ctx-size",
        &ctx_size.to_string(),
        // Preserve b9095's current auto policy explicitly. Supplying
        // --parallel alone disables the auto branch that enables unified KV,
        // so all three flags belong together. CLI arguments also override any
        // inherited LLAMA_ARG_* environment settings.
        "--parallel",
        "4",
        "--kv-unified",
        "--cont-batching",
        "--n-gpu-layers",
        N_GPU_LAYERS,
        "--model",
        model_path,
    ]);
    if let Some(p) = mmproj_path {
        command = command.args(["--mmproj", p]);
    }
    if let Some(dir) = runtime_dir {
        // I75: the prebuilt llama.cpp binary is a GGML_BACKEND_DL build —
        // ggml-cpu-*/metal/blas are separate libs it dlopen()s at startup,
        // not linked imports. ggml's loader (ggml_backend_load_best) globs
        // exactly two places for those: the executable's own directory and
        // the process's current working directory — never PATH /
        // DYLD_FALLBACK_LIBRARY_PATH / LD_LIBRARY_PATH, which only satisfy
        // the *linked* imports (llama.dll/ggml-base.dll etc, resolved below).
        // Without this, the child starts and logs its banner, then dies with
        // "no backends are loaded" the moment it tries to load a model.
        command = command.current_dir(dir);

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
        .map_err(|e| format!("spawn {}: {e}", binary.display()))
}

// Consecutive respawns that each died before MIN_HEALTHY_UPTIME accumulate
// toward RESTART_BUDGET; a child that ran at least that long is a durable
// server, so its later death starts the streak over at 1.
fn next_attempts(prev: u32, uptime: Duration) -> u32 {
    if uptime >= MIN_HEALTHY_UPTIME {
        1
    } else {
        prev + 1
    }
}

// I83 — has this generation respawned so many times that the engine should be
// called dead regardless of how long each child survived? Separate from
// `next_attempts` on purpose: that one answers "is this a crash loop right
// now?", this one answers "has this been going on all session?".
fn exceeded_total_restarts(total: u32) -> bool {
    total > TOTAL_RESTART_BUDGET
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
    // I83 — every respawn in this generation, never reset by a clean run.
    let mut total_restarts: u32 = 0;
    let mut child_started_at = Instant::now();

    loop {
        let mut last_exit: Option<String> = None;
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => {
                    with_sidecar_log(|| {
                        let _ = write!(log, "[stdout gen={generation}] ");
                        let _ = log.write_all(&bytes);
                        let _ = log.write_all(b"\n");
                    });
                }
                CommandEvent::Stderr(bytes) => {
                    with_sidecar_log(|| {
                        let _ = write!(log, "[stderr gen={generation}] ");
                        let _ = log.write_all(&bytes);
                        let _ = log.write_all(b"\n");
                    });
                }
                CommandEvent::Terminated(payload) => {
                    with_sidecar_log(|| {
                        let _ = writeln!(
                            log,
                            "[event gen={generation}] terminated code={:?}",
                            payload.code
                        );
                    });
                    last_exit = Some(format!("exit {:?}", payload.code));
                    break;
                }
                CommandEvent::Error(err) => {
                    with_sidecar_log(|| {
                        let _ = writeln!(log, "[event gen={generation}] error: {err}");
                    });
                    last_exit = Some(err);
                    break;
                }
                _ => {}
            }
        }
        with_sidecar_log(|| {
            let _ = log.flush();
        });

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

        // Count consecutive short-lived deaths; a durable child resets to 1.
        restart_attempts = next_attempts(restart_attempts, child_started_at.elapsed());
        total_restarts += 1;
        // I83 — a slow crash loop clears MIN_HEALTHY_UPTIME on every cycle, so
        // the streak check below can never fire for it. Stop pretending this
        // engine is going to recover.
        if exceeded_total_restarts(total_restarts) {
            guard.errored = true;
            guard.last_error = Some(append_windows_dll_hint(format!(
                "the AI engine restarted {total_restarts} times this session and kept dying"
            )));
            guard.port = None;
            with_sidecar_log(|| {
                let _ = writeln!(
                    log,
                    "[event gen={generation}] giving up after {total_restarts} lifetime restarts (slow crash loop)"
                );
                let _ = log.flush();
            });
            return;
        }
        if restart_attempts > RESTART_BUDGET {
            guard.errored = true;
            // I83 — carry the Windows VC++ hint here too. A child that dies
            // inside the loader spawns successfully (CreateProcess returns a
            // handle before the DLL resolution that kills it), so it never
            // reaches the spawn-failure path where this hint was applied — it
            // crash-loops to the restart budget instead, and the toast the JS
            // side raises from `last_error` named an exit code and nothing the
            // user could act on.
            guard.last_error = last_exit
                .clone()
                .or_else(|| Some(format!("restart budget exceeded ({RESTART_BUDGET})")))
                .map(append_windows_dll_hint);
            guard.port = None;
            with_sidecar_log(|| {
                let _ = writeln!(
                    log,
                    "[event gen={generation}] giving up after {restart_attempts} restart attempts"
                );
                let _ = log.flush();
            });
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
                with_sidecar_log(|| {
                    let _ = writeln!(log, "[event gen={generation}] pick_unused_port failed: {e}");
                    let _ = log.flush();
                });
                return;
            }
        };
        // Same candidate chain as the initial start, but never a download —
        // the respawn path must stay fast and offline-safe.
        let spawn_result =
            spawn_with_fallback(&app, &model_path, mmproj_path.as_deref(), ctx_size, port);
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
                with_sidecar_log(|| {
                    let _ = writeln!(log, "[event gen={generation}] respawn failed: {e}");
                    let _ = log.flush();
                });
                return;
            }
        };
        let mut guard = state.lock().await;
        if guard.generation != generation {
            // Another start replaced us in the gap; let our spawned child die.
            let _ = new_child.kill();
            return;
        }
        with_sidecar_log(|| {
            let _ = writeln!(log, "[event gen={generation}] respawned on port {port}");
            let _ = log.flush();
        });
        guard.child = Some(new_child);
        guard.port = Some(port);
        drop(guard);
        rx = new_rx;
        child_started_at = Instant::now();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch_log(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "studyvis-sidecar-test-{name}-{}",
            std::process::id()
        ))
    }

    #[test]
    fn retained_engine_log_keeps_only_the_newest_complete_lines() {
        let path = scratch_log("trim");
        let _ = fs::remove_file(&path);
        let mut source = vec![b'x'; 80];
        source.extend_from_slice(b"\nkeep-one\nkeep-two\n");
        fs::write(&path, source).unwrap();

        let contents = read_retained_tail(&path, 64).unwrap();

        assert!(contents.len() <= 64);
        assert!(contents.starts_with(RETAINED_TAIL_MARKER));
        assert!(contents.ends_with(b"keep-one\nkeep-two\n"));
        assert!(!contents.contains(&b'x'));
        let _ = fs::remove_file(path);
    }

    #[test]
    fn sidecar_rotation_caps_the_new_generation_and_truncates_live() {
        let path = scratch_log("rotation");
        let _ = fs::remove_file(&path);
        let _ = fs::remove_file(crate::commands::applog::rotated_log_path(&path, 1));
        let _ = fs::remove_file(crate::commands::applog::rotated_log_path(&path, 2));
        let mut source = vec![b'x'; 80];
        source.extend_from_slice(b"\nkeep-one\nkeep-two\n");
        fs::write(&path, source).unwrap();
        fs::write(
            crate::commands::applog::rotated_log_path(&path, 1),
            b"older-generation\n",
        )
        .unwrap();

        rotate_sidecar_log_history(&path, 2, 64).unwrap();

        assert_eq!(fs::metadata(&path).unwrap().len(), 0);
        let newest = fs::read(crate::commands::applog::rotated_log_path(&path, 1)).unwrap();
        assert!(newest.len() <= 64);
        assert!(newest.starts_with(RETAINED_TAIL_MARKER));
        assert!(newest.ends_with(b"keep-one\nkeep-two\n"));
        assert_eq!(
            fs::read(crate::commands::applog::rotated_log_path(&path, 2)).unwrap(),
            b"older-generation\n"
        );
        let _ = fs::remove_file(&path);
        let _ = fs::remove_file(crate::commands::applog::rotated_log_path(&path, 1));
        let _ = fs::remove_file(crate::commands::applog::rotated_log_path(&path, 2));
    }

    #[test]
    fn short_lived_child_increments_toward_budget() {
        assert_eq!(next_attempts(3, Duration::from_secs(5)), 4);
        assert!(next_attempts(3, Duration::from_secs(5)) > RESTART_BUDGET);
    }

    #[test]
    fn durable_child_resets_streak() {
        assert_eq!(next_attempts(3, MIN_HEALTHY_UPTIME), 1);
    }

    #[test]
    fn first_crash_starts_at_one() {
        assert_eq!(next_attempts(0, Duration::from_secs(1)), 1);
    }

    // I83 — the hole the lifetime cap closes: a child dying just past
    // MIN_HEALTHY_UPTIME resets the consecutive streak on every cycle, so
    // `restart_attempts` never exceeds RESTART_BUDGET and `errored` is never
    // set. Simulate that cycle and show the streak rule alone never gives up.
    #[test]
    fn slow_crash_loop_never_trips_the_consecutive_streak() {
        let mut attempts = 0;
        let just_past_healthy = MIN_HEALTHY_UPTIME + Duration::from_secs(1);
        for _ in 0..50 {
            attempts = next_attempts(attempts, just_past_healthy);
            assert!(
                attempts <= RESTART_BUDGET,
                "a 121s crash cycle must never reach the streak budget — \
                 that is exactly why the lifetime cap exists"
            );
        }
    }

    #[test]
    fn lifetime_cap_stops_a_slow_crash_loop() {
        // The same cycle, counted the other way: every respawn accumulates.
        assert!(!exceeded_total_restarts(TOTAL_RESTART_BUDGET));
        assert!(exceeded_total_restarts(TOTAL_RESTART_BUDGET + 1));
    }

    #[test]
    fn lifetime_cap_leaves_a_long_healthy_session_alone() {
        // An 8-hour session whose sidecar dies once an hour after clean uptime
        // spends 8 respawns. It must never be called a crash loop.
        assert!(!exceeded_total_restarts(8));
    }
}
