use std::sync::atomic::{AtomicBool, Ordering};

use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_autostart::ManagerExt;
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
