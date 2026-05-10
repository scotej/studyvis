use std::sync::atomic::{AtomicBool, Ordering};

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

// Default true: matches V1-P7 close-to-tray behavior; the JS settings store
// pushes the user's saved preference on first render via
// `system_minimize_to_tray_set_enabled`. Reading via Relaxed is safe because
// the only consumer (`on_window_event`) does not need to race with the JS
// command — last-write-wins is fine and the cost of a stale read is one
// duplicate close attempt.
pub struct MinimizeToTrayFlag(pub AtomicBool);

impl MinimizeToTrayFlag {
    pub fn new() -> Self {
        Self(AtomicBool::new(true))
    }

    pub fn set<R: Runtime>(app: &AppHandle<R>, enabled: bool) {
        app.state::<Self>().0.store(enabled, Ordering::Relaxed);
    }

    pub fn is_enabled<R: Runtime>(app: &AppHandle<R>) -> bool {
        app.state::<Self>().0.load(Ordering::Relaxed)
    }
}

#[tauri::command]
pub fn autostart_set_enabled<R: Runtime>(
    app: AppHandle<R>,
    enabled: bool,
) -> Result<(), String> {
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
pub fn system_open_data_folder<R: Runtime>(app: AppHandle<R>) -> Result<String, String> {
    let dir = data_dir(&app)?;
    let dir_str = dir.to_string_lossy().into_owned();
    app.opener()
        .reveal_item_in_dir(&dir_str)
        .map_err(|e| e.to_string())?;
    Ok(dir_str)
}

#[tauri::command]
pub fn system_open_url<R: Runtime>(app: AppHandle<R>, url: String) -> Result<(), String> {
    // Restrict to https only — the About card opens the public Releases page,
    // and refusing other schemes here keeps the IPC narrow even though the
    // command is only called from our own UI.
    if !url.starts_with("https://") {
        return Err("only https URLs are accepted".into());
    }
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| e.to_string())
}
