use std::str::FromStr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};
use tauri_plugin_opener::OpenerExt;

use crate::db::data_dir;

pub struct QuitFlag(pub AtomicBool);

impl QuitFlag {
    pub fn new() -> Self {
        Self(AtomicBool::new(false))
    }

    pub fn arm<R: Runtime>(app: &AppHandle<R>) {
        app.state::<Self>().0.store(true, Ordering::Relaxed);
    }

    pub fn is_armed<R: Runtime>(app: &AppHandle<R>) -> bool {
        app.state::<Self>().0.load(Ordering::Relaxed)
    }
}

// Initial value comes from `settings.json` at app boot (see
// `read_minimize_to_tray_from_settings` in lib.rs); the JS settings store
// pushes subsequent updates via `system_minimize_to_tray_set_enabled`. Reading
// from disk during `setup` closes a Cmd+W race window where the previous
// implementation defaulted to `true` until JS hydrated, so a user with the
// flag persisted as `false` could see one stray hide-to-tray on the first
// close before settings hydration. Relaxed ordering is safe because the only
// consumer (`on_window_event`) does not need to race with the JS command —
// last-write-wins is fine and the cost of a stale read is one duplicate
// close attempt.
pub struct MinimizeToTrayFlag(pub AtomicBool);

impl MinimizeToTrayFlag {
    pub fn new(initial: bool) -> Self {
        Self(AtomicBool::new(initial))
    }

    pub fn set<R: Runtime>(app: &AppHandle<R>, enabled: bool) {
        app.state::<Self>().0.store(enabled, Ordering::Relaxed);
    }

    pub fn is_enabled<R: Runtime>(app: &AppHandle<R>) -> bool {
        app.state::<Self>().0.load(Ordering::Relaxed)
    }
}

// V2-P9 AI-features gate. Initial value comes from `settings.json` at app
// boot (see `read_ai_features_from_settings` in lib.rs); the JS settings store
// pushes subsequent updates via `system_ai_features_set_enabled`. The only
// consumer is the global Ctrl+] shortcut handler, which no-ops when the flag
// is off so the floating AI dialog never opens while AI is disabled. Relaxed
// ordering matches `MinimizeToTrayFlag`: last-write-wins is fine and a stale
// read costs at most one extra (or skipped) dialog toggle.
pub struct AiFeaturesFlag(pub AtomicBool);

impl AiFeaturesFlag {
    pub fn new(initial: bool) -> Self {
        Self(AtomicBool::new(initial))
    }

    pub fn set<R: Runtime>(app: &AppHandle<R>, enabled: bool) {
        app.state::<Self>().0.store(enabled, Ordering::Relaxed);
    }

    pub fn is_enabled<R: Runtime>(app: &AppHandle<R>) -> bool {
        app.state::<Self>().0.load(Ordering::Relaxed)
    }
}

// V3-P3 — runtime-mutable global shortcut bindings. The two `Mutex<Shortcut>`
// fields are the V1-P7 interior-mutability pattern: the handler locks the
// same Mutex per keystroke to compare against the *current* shortcut, and
// `system_set_global_shortcut` swaps the held value after unregister +
// register both succeed. `std::sync::Mutex` is enough — the lock is held
// for a single field copy.
pub struct ShortcutBindings {
    ptt_friends: Mutex<Shortcut>,
    ptt_ai: Mutex<Shortcut>,
}

impl ShortcutBindings {
    // Always returns a valid binding pair: a malformed `initial_*` (empty
    // string, unparseable accelerator from a manually-edited settings.json,
    // etc.) silently falls back to the shipped default so boot registration
    // is as forgiving as the JS hydrator. The defaults are known-parseable
    // string constants, so the inner `expect` cannot trip.
    pub fn new(initial_ptt_friends: &str, initial_ptt_ai: &str) -> Self {
        Self {
            ptt_friends: Mutex::new(Self::parse_or_default(
                initial_ptt_friends,
                DEFAULT_PTT_FRIENDS_ACCELERATOR,
            )),
            ptt_ai: Mutex::new(Self::parse_or_default(
                initial_ptt_ai,
                DEFAULT_PTT_AI_ACCELERATOR,
            )),
        }
    }

    fn parse_or_default(pref: &str, default_accelerator: &str) -> Shortcut {
        if let Ok(s) = Shortcut::from_str(pref) {
            return s;
        }
        Shortcut::from_str(default_accelerator).expect("default accelerator must parse")
    }

    pub fn ptt_friends(&self) -> Shortcut {
        // Recover from a poisoned mutex (an unrelated panic while a previous
        // handler held the lock) so the global shortcut handler never
        // crashes the process on a hot path.
        *self.ptt_friends.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn ptt_ai(&self) -> Shortcut {
        *self.ptt_ai.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn store_ptt_friends(&self, shortcut: Shortcut) {
        *self.ptt_friends.lock().unwrap_or_else(|e| e.into_inner()) = shortcut;
    }

    fn store_ptt_ai(&self, shortcut: Shortcut) {
        *self.ptt_ai.lock().unwrap_or_else(|e| e.into_inner()) = shortcut;
    }
}

const DEFAULT_PTT_FRIENDS_ACCELERATOR: &str = "CmdOrCtrl+[";
const DEFAULT_PTT_AI_ACCELERATOR: &str = "CmdOrCtrl+]";

// Swap one of the two global shortcuts at runtime. Unregister-then-register
// (per the tauri-plugin-global-shortcut guidance; double-registering the
// same combo silently fails on some macOS versions). The Mutex update only
// runs after both side-effects succeed so a partial failure can't leave
// the handler stale.
#[tauri::command]
pub fn system_set_global_shortcut<R: Runtime>(
    app: AppHandle<R>,
    action: String,
    accelerator: String,
) -> Result<(), String> {
    let new_shortcut = Shortcut::from_str(&accelerator)
        .map_err(|e| format!("Couldn't read {accelerator}: {e}"))?;
    let bindings = app.state::<ShortcutBindings>();
    let old_shortcut = match action.as_str() {
        "ptt-friends" => bindings.ptt_friends(),
        "ptt-ai" => bindings.ptt_ai(),
        _ => return Err(format!("unknown shortcut action: {action}")),
    };
    if old_shortcut == new_shortcut {
        return Ok(());
    }
    let manager = app.global_shortcut();
    manager
        .unregister(old_shortcut)
        .map_err(|e| format!("Couldn't unregister the old shortcut: {e}"))?;
    if let Err(err) = manager.register(new_shortcut) {
        // Best-effort: try to put the old one back so the user isn't left
        // with no PTT binding while their UI shows the rejected new one.
        let _ = manager.register(old_shortcut);
        return Err(format!("Couldn't register {accelerator}: {err}"));
    }
    match action.as_str() {
        "ptt-friends" => bindings.store_ptt_friends(new_shortcut),
        "ptt-ai" => bindings.store_ptt_ai(new_shortcut),
        _ => unreachable!("action validated above"),
    }
    Ok(())
}

#[tauri::command]
pub fn autostart_set_enabled<R: Runtime>(app: AppHandle<R>, enabled: bool) -> Result<(), String> {
    let manager = app.autolaunch();
    if enabled {
        manager.enable().map_err(|e| e.to_string())
    } else {
        manager.disable().map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub fn autostart_is_enabled<R: Runtime>(app: AppHandle<R>) -> Result<bool, String> {
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn system_minimize_to_tray_set_enabled<R: Runtime>(
    app: AppHandle<R>,
    enabled: bool,
) -> Result<(), String> {
    MinimizeToTrayFlag::set(&app, enabled);
    Ok(())
}

#[tauri::command]
pub fn system_ai_features_set_enabled<R: Runtime>(
    app: AppHandle<R>,
    enabled: bool,
) -> Result<(), String> {
    AiFeaturesFlag::set(&app, enabled);
    Ok(())
}

#[tauri::command]
pub fn system_open_data_folder<R: Runtime>(app: AppHandle<R>) -> Result<String, String> {
    let dir = data_dir(&app)?;
    let dir_str = dir.to_string_lossy().into_owned();
    app.opener()
        .reveal_item_in_dir(&dir_str)
        .map_err(|e| e.to_string())?;
    Ok(dir_str)
}

// The About card needs exactly one outbound URL — the GitHub Releases page —
// so the command takes no parameters. This keeps the JS-callable IPC surface
// to a single hardcoded destination rather than a generic open-any-URL.
const RELEASES_URL: &str = "https://github.com/scotej/studyvis/releases";

#[tauri::command]
pub fn system_open_releases<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    app.opener()
        .open_url(RELEASES_URL, None::<&str>)
        .map_err(|e| e.to_string())
}

// V2-P5 battery awareness for the AI sample loop. ARCHITECTURE.md §8: "if
// user_on_battery and battery_pct < 20: pause AI". Returned shape matches
// the `RawBattery` interface in `src/features/ai/battery.ts`.
//
// Desktops / VMs without a battery and Linux machines without UPower return
// a graceful "on AC, 100%" so the sample loop keeps ticking; that's safer
// than refusing inference on hardware the crate can't introspect.
#[derive(Serialize)]
pub struct BatteryInfo {
    pub on_battery: bool,
    pub percent: u8,
}

#[tauri::command]
pub fn system_battery() -> Result<BatteryInfo, String> {
    let manager = match battery::Manager::new() {
        Ok(m) => m,
        Err(_) => return Ok(no_battery_fallback()),
    };
    let mut iter = match manager.batteries() {
        Ok(it) => it,
        Err(_) => return Ok(no_battery_fallback()),
    };
    let primary = match iter.next() {
        Some(Ok(b)) => b,
        Some(Err(_)) | None => return Ok(no_battery_fallback()),
    };
    let raw_pct = primary.state_of_charge().value * 100.0;
    let pct_clamped = if raw_pct.is_finite() {
        raw_pct.clamp(0.0, 100.0)
    } else {
        100.0
    };
    let on_battery = matches!(primary.state(), battery::State::Discharging);
    Ok(BatteryInfo {
        on_battery,
        percent: pct_clamped.round() as u8,
    })
}

fn no_battery_fallback() -> BatteryInfo {
    BatteryInfo {
        on_battery: false,
        percent: 100,
    }
}

// V3-P6 — Relaunches the StudyVis process. Used by Settings → Appearance
// after the user toggles the custom window-chrome preference: the
// decoration / title-bar-style swap takes effect at the *next* Rust
// `setup()` boot (see `apply_window_style` in lib.rs), so a clean restart
// is the honest path. `AppHandle::restart` is divergent — it replaces the
// current process and never returns — so the `Result` return type is
// kept for `#[tauri::command]` ergonomics and the value never resolves.
#[tauri::command]
pub fn system_relaunch_app<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    app.restart()
}

// macOS Sequoia surfaces Screen Recording grants as a per-app entry in
// System Settings → Privacy & Security → Screen Recording. The
// `x-apple.systempreferences` URL scheme jumps the user straight to that
// pane. On non-macOS targets the command no-ops with an error so callers
// fall back to a textual instruction.
#[tauri::command]
pub fn system_open_screen_capture_settings<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        const URL: &str =
            "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";
        app.opener()
            .open_url(URL, None::<&str>)
            .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Err("not supported on this platform".to_string())
    }
}
