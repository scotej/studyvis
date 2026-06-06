mod commands;
pub mod crypto;
pub mod db;

use tauri::Manager;

#[cfg(desktop)]
use commands::ai_dialog::toggle_ai_dialog;
use commands::friends::{
    friends_add, friends_get_x_pubkey, friends_list, friends_remove, friends_update_last_studied,
};
#[cfg(any(target_os = "macos", target_os = "windows"))]
use commands::identity::{
    identity_box_decrypt, identity_box_encrypt, identity_exists, identity_load_record,
    identity_save_keys, identity_save_record, identity_sign,
};
#[cfg(all(desktop, any(target_os = "macos", target_os = "windows")))]
use commands::models::{hf_token_clear, hf_token_present, hf_token_save};
#[cfg(desktop)]
use commands::models::{
    model_download, model_download_cancel, model_head_check, model_install_state, model_paths,
    model_remove, DownloadState,
};
use commands::sessions::{
    audit_event_insert, audit_events_list_for_session, sessions_get, sessions_insert, sessions_list,
};
#[cfg(desktop)]
use commands::sidecar::{
    diagnostics_info, diagnostics_reveal_log, sidecar_start, sidecar_status, sidecar_stop,
    SidecarState,
};
#[cfg(desktop)]
use commands::system::{
    autostart_is_enabled, autostart_set_enabled, system_ai_features_set_enabled, system_battery,
    system_minimize_to_tray_set_enabled, system_open_camera_settings, system_open_data_folder,
    system_open_microphone_settings, system_open_releases, system_open_screen_capture_settings,
    system_relaunch_app, system_set_global_shortcut, AiFeaturesFlag, MinimizeToTrayFlag, QuitFlag,
    ShortcutBindings,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_opener::init());

    // `tauri::generate_handler!` accepts outer attributes on individual
    // entries (each becomes a match arm in the generated dispatcher), so a
    // single invocation with `#[cfg(...)]` gates per-command replaces the
    // previous three near-duplicate handler blocks.
    let builder = builder.invoke_handler(tauri::generate_handler![
        friends_list,
        friends_add,
        friends_remove,
        friends_update_last_studied,
        friends_get_x_pubkey,
        sessions_insert,
        sessions_list,
        sessions_get,
        audit_event_insert,
        audit_events_list_for_session,
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        identity_save_keys,
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        identity_exists,
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        identity_save_record,
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        identity_load_record,
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        identity_sign,
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        identity_box_decrypt,
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        identity_box_encrypt,
        #[cfg(desktop)]
        autostart_set_enabled,
        #[cfg(desktop)]
        autostart_is_enabled,
        #[cfg(desktop)]
        system_minimize_to_tray_set_enabled,
        #[cfg(desktop)]
        system_ai_features_set_enabled,
        #[cfg(desktop)]
        system_open_data_folder,
        #[cfg(desktop)]
        system_open_releases,
        #[cfg(desktop)]
        system_open_screen_capture_settings,
        #[cfg(desktop)]
        system_open_camera_settings,
        #[cfg(desktop)]
        system_open_microphone_settings,
        #[cfg(desktop)]
        system_set_global_shortcut,
        #[cfg(desktop)]
        system_relaunch_app,
        #[cfg(desktop)]
        system_battery,
        #[cfg(desktop)]
        sidecar_start,
        #[cfg(desktop)]
        sidecar_stop,
        #[cfg(desktop)]
        sidecar_status,
        #[cfg(desktop)]
        diagnostics_reveal_log,
        #[cfg(desktop)]
        diagnostics_info,
        #[cfg(desktop)]
        model_paths,
        #[cfg(desktop)]
        model_install_state,
        #[cfg(desktop)]
        model_remove,
        #[cfg(desktop)]
        model_head_check,
        #[cfg(desktop)]
        model_download,
        #[cfg(desktop)]
        model_download_cancel,
        #[cfg(all(desktop, any(target_os = "macos", target_os = "windows")))]
        hf_token_save,
        #[cfg(all(desktop, any(target_os = "macos", target_os = "windows")))]
        hf_token_present,
        #[cfg(all(desktop, any(target_os = "macos", target_os = "windows")))]
        hf_token_clear,
    ]);

    let builder = builder.on_window_event(|window, event| {
        if window.label() != "main" {
            return;
        }
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            #[cfg(desktop)]
            {
                let app = window.app_handle();
                if QuitFlag::is_armed(app) {
                    return;
                }
                if !MinimizeToTrayFlag::is_enabled(app) {
                    // User has opted out of close-to-tray; honor a real quit.
                    // On macOS this matches native Cmd+Q expectation; on
                    // Windows / Linux closing the window exits the process.
                    return;
                }
                api.prevent_close();
                let _ = window.hide();
            }
            #[cfg(not(desktop))]
            {
                let _ = api;
            }
        }
    });

    let app = builder
        .setup(|app| {
            let pool = db::init(app.handle())
                .map_err(|e| -> Box<dyn std::error::Error> { format!("db init: {e}").into() })?;
            app.manage(pool);

            #[cfg(desktop)]
            {
                app.manage(QuitFlag::new());
                let initial_minimize_to_tray =
                    read_minimize_to_tray_from_settings(app.handle()).unwrap_or(true);
                app.manage(MinimizeToTrayFlag::new(initial_minimize_to_tray));
                let initial_ai_features =
                    read_ai_features_from_settings(app.handle()).unwrap_or(false);
                app.manage(AiFeaturesFlag::new(initial_ai_features));
                let (initial_ptt_friends, initial_ptt_ai) =
                    read_shortcut_accelerators_from_settings(app.handle());
                app.manage(ShortcutBindings::new(&initial_ptt_friends, &initial_ptt_ai));
                app.manage(SidecarState::new());
                app.manage(DownloadState::new());
                setup_desktop(app)?;
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    // Switching from `.run(generate_context!())` to `.build(...)?.run(|...|)`
    // gives us the RunEvent stream so we can stop the llama-server sidecar
    // before the Tauri runtime tears down. ExitRequested fires on every
    // requested shutdown path (tray-quit, Cmd+Q with minimize-to-tray=false,
    // OS-initiated shutdown); Exit fires after the runtime commits to exit.
    // Killing in either path is safe — the second hit no-ops because the
    // child handle has already been taken.
    app.run(|app_handle, event| match event {
        #[cfg(desktop)]
        tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit => {
            SidecarState::kill_blocking(app_handle);
        }
        _ => {}
    });
}

// Reads the persisted `minimize_to_tray_on_close` flag from
// `settings.json` (the LazyStore file written by `useSettingsStore`) so the
// boot value of `MinimizeToTrayFlag` reflects the user's saved preference
// before JS hydration. The settings file lives at
// `path::app_data_dir()/settings.json` because tauri-plugin-store resolves
// relative paths via `BaseDirectory::AppData` — this is a different
// directory from `db::data_dir()` (which is `path::data_dir()/studyvis`)
// where `identity.json` and `app.db` live.
//
// Returns `None` for any failure mode (file missing, unreadable, malformed
// JSON, key absent, key wrong type) and lets the caller substitute the
// default. `serde_json::Value` keeps parsing forgiving so future schema
// additions don't break boot.
#[cfg(desktop)]
fn read_minimize_to_tray_from_settings<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> Option<bool> {
    const SETTINGS_FILE: &str = "settings.json";
    const KEY_MINIMIZE_TO_TRAY: &str = "minimize_to_tray_on_close";
    let dir = app.path().app_data_dir().ok()?;
    let bytes = std::fs::read(dir.join(SETTINGS_FILE)).ok()?;
    let value: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    value.get(KEY_MINIMIZE_TO_TRAY)?.as_bool()
}

// Same one-shot read for the AI-features gate so the global Ctrl+] shortcut
// honors the saved preference before JS hydration. Defaults to `false` (AI
// off) so a fresh install or any read failure keeps every AI surface dormant
// — matching `DEFAULT_SETTINGS.aiFeaturesEnabled`.
#[cfg(desktop)]
fn read_ai_features_from_settings<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Option<bool> {
    const SETTINGS_FILE: &str = "settings.json";
    const KEY_AI_FEATURES: &str = "ai_features_enabled";
    let dir = app.path().app_data_dir().ok()?;
    let bytes = std::fs::read(dir.join(SETTINGS_FILE)).ok()?;
    let value: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    value.get(KEY_AI_FEATURES)?.as_bool()
}

// V3-P6 — Opt-in custom window chrome.
//
// The JS settings store persists `window_style: "system" | "custom"` to
// `settings.json`. Rust reads it here at boot — *before* the main window
// paints — and applies decoration / title-bar-style via the platform-
// specific path:
//   * macOS: `TitleBarStyle::Overlay` so the system traffic lights stay
//     alive (double-click-zoom, fullscreen toggle, snap all keep working
//     natively) but the title-bar band is transparent and our painted
//     wordmark sits in the overlap. We also clear the window title with
//     `set_title("")` so the OS-rendered title text doesn't paint over
//     the wordmark.
//   * Windows: `set_decorations(false)` removes the native frame; the
//     `<TitleBar />` React component renders our own min/restore/close
//     cluster. `data-tauri-drag-region` provides the drag surface.
//
// Live swap is intentionally NOT implemented: tauri-apps/tauri#9673 and
// #12042 document unreliable `setDecorations` behavior on macOS and
// inconsistent visual results across OSes. Toggling the setting writes
// the file and the Appearance row prompts a relaunch via the new
// `system_relaunch_app` command — honest, simple, regression-proof.
//
// On every other state (default `'system'`, missing file, malformed
// JSON, unknown enum value) the function returns `false` and the main
// window stays at its conf-defined chrome — exactly the v1.0.3 shipped
// behavior.
#[cfg(desktop)]
fn read_window_style_is_custom_from_settings<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> bool {
    const SETTINGS_FILE: &str = "settings.json";
    const KEY_WINDOW_STYLE: &str = "window_style";
    let read = || -> Option<bool> {
        let dir = app.path().app_data_dir().ok()?;
        let bytes = std::fs::read(dir.join(SETTINGS_FILE)).ok()?;
        let value: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
        Some(value.get(KEY_WINDOW_STYLE)?.as_str()? == "custom")
    };
    read().unwrap_or(false)
}

#[cfg(desktop)]
fn apply_window_style<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    use tauri::Manager;

    if !read_window_style_is_custom_from_settings(app) {
        return;
    }
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    #[cfg(target_os = "macos")]
    {
        if let Err(err) = window.set_title_bar_style(tauri::TitleBarStyle::Overlay) {
            eprintln!("[window-chrome] set_title_bar_style failed: {err}");
        }
        // Clear the title so the OS doesn't paint title text on top of
        // our wordmark in the overlay band. The menubar's app entry
        // still shows "StudyVis" from the bundle Info.plist.
        let _ = window.set_title("");
    }
    #[cfg(target_os = "windows")]
    {
        if let Err(err) = window.set_decorations(false) {
            eprintln!("[window-chrome] set_decorations(false) failed: {err}");
        }
    }
    // Linux / other unix targets: V3-P6 explicitly scopes to macOS +
    // Windows (PLAN.md §5 release matrix). If a user runs the dev build
    // on another platform and somehow toggled custom, the window keeps
    // its native chrome and the React `<TitleBar />` still renders — a
    // visible double-titlebar that signals "not supported here." The
    // setting default is 'system' on every platform, so this path is
    // only reached if the user actively opted in.
}

// One-shot read of the persisted accelerator strings (V3-P3). Any missing
// or malformed value falls back to the shipped defaults — same defaults
// `DEFAULT_SETTINGS` uses on the JS side, so the first registration always
// matches what the user sees in Settings → Shortcuts before they touch
// anything.
#[cfg(desktop)]
fn read_shortcut_accelerators_from_settings<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> (String, String) {
    const SETTINGS_FILE: &str = "settings.json";
    const KEY_PTT_FRIENDS: &str = "ptt_friends_accelerator";
    const KEY_PTT_AI: &str = "ptt_ai_accelerator";
    const DEFAULT_PTT_FRIENDS: &str = "CmdOrCtrl+[";
    const DEFAULT_PTT_AI: &str = "CmdOrCtrl+]";
    let read = || -> Option<serde_json::Value> {
        let dir = app.path().app_data_dir().ok()?;
        let bytes = std::fs::read(dir.join(SETTINGS_FILE)).ok()?;
        serde_json::from_slice(&bytes).ok()
    };
    let value = read();
    // `.filter(|s| !s.is_empty())` collapses a persisted empty string into
    // the same "missing" branch as a non-string value, so boot registration
    // never fails on a manually-edited `settings.json` with an empty
    // accelerator. The JS hydrator already treats `""` as missing; mirror
    // that here.
    let friends = value
        .as_ref()
        .and_then(|v| v.get(KEY_PTT_FRIENDS))
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| DEFAULT_PTT_FRIENDS.to_owned());
    let ai = value
        .as_ref()
        .and_then(|v| v.get(KEY_PTT_AI))
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| DEFAULT_PTT_AI.to_owned());
    (friends, ai)
}

#[cfg(desktop)]
fn setup_desktop(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    use tauri::{
        include_image,
        menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem},
        tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
        Emitter,
    };
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

    // V3-P6 — Apply the saved chrome preference before paint. Idempotent
    // on every other path (default `'system'`, missing file, etc.). The
    // window is configured `visible: false` in tauri.conf.json so that
    // the native decoration is never painted before `set_decorations(false)`
    // / `set_title_bar_style(Overlay)` lands — V3-P7 fixes the V3-P6
    // one-frame native-frame flash by deferring `window.show()` to the
    // end of this setup, after `apply_window_style` has had its say.
    apply_window_style(app.handle());

    app.handle().plugin(tauri_plugin_autostart::init(
        tauri_plugin_autostart::MacosLauncher::LaunchAgent,
        None::<Vec<&str>>,
    ))?;

    // updater registration deferred to V3 — friends-only V1 ships without
    // auto-update; see V1-P12 scope decision.

    // Active shortcuts live in `ShortcutBindings::Mutex<Shortcut>` so the
    // V3-P3 `system_set_global_shortcut` command can swap them at runtime.
    // The handler locks the same Mutex on every press/release — Mutex
    // contention is per-keystroke and trivial.
    let (initial_ptt_friends, initial_ptt_ai) = {
        let bindings = app.state::<ShortcutBindings>();
        (bindings.ptt_friends(), bindings.ptt_ai())
    };
    app.handle().plugin(
        tauri_plugin_global_shortcut::Builder::new()
            .with_handler(move |app, shortcut, event| {
                let bindings = app.state::<ShortcutBindings>();
                let ptt_friends = bindings.ptt_friends();
                let ptt_ai = bindings.ptt_ai();
                if shortcut == &ptt_friends {
                    match event.state() {
                        ShortcutState::Pressed => {
                            let _ = app.emit("ptt-friends-pressed", ());
                        }
                        ShortcutState::Released => {
                            let _ = app.emit("ptt-friends-released", ());
                        }
                    }
                } else if shortcut == &ptt_ai {
                    // V2-P7 wires this shortcut to the floating Ctrl+] AI
                    // dialog window. Fire only on key-down so a press/release
                    // pair doesn't open then immediately close. V2-P9 gates it
                    // on the AI-features flag so "AI off → zero AI surface"
                    // holds even when the user hits the key.
                    if event.state() == ShortcutState::Pressed && AiFeaturesFlag::is_enabled(app) {
                        if let Err(err) = toggle_ai_dialog(app) {
                            eprintln!("[ai-dialog] toggle failed: {err}");
                        }
                    }
                }
            })
            .build(),
    )?;
    // A hand-edited settings.json can set both PTT accelerators to the same
    // combo. Registering an identical combo twice errors (Windows returns
    // ERROR_HOTKEY_ALREADY_REGISTERED), which would propagate out of setup()
    // and abort boot with no UI recourse. Register one copy when they collide;
    // the handler still fires the friends branch and the user can rebind in
    // Settings → Shortcuts.
    let to_register = if initial_ptt_friends == initial_ptt_ai {
        vec![initial_ptt_friends]
    } else {
        vec![initial_ptt_friends, initial_ptt_ai]
    };
    app.global_shortcut().register_multiple(to_register)?;

    let tray_icon = include_image!("icons/tray/22x22.png");
    let open_item = MenuItemBuilder::with_id("tray-open", "Open StudyVis").build(app)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit_item = MenuItemBuilder::with_id("tray-quit", "Quit").build(app)?;
    let menu = MenuBuilder::new(app)
        .items(&[&open_item, &separator, &quit_item])
        .build()?;

    TrayIconBuilder::with_id("studyvis-main")
        .icon(tray_icon)
        .icon_as_template(true)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "tray-open" => show_main_window(app),
            "tray-quit" => {
                QuitFlag::arm(app);
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                if let Some(window) = app.get_webview_window("main") {
                    let visible = window.is_visible().unwrap_or(false);
                    let focused = window.is_focused().unwrap_or(false);
                    if visible && focused {
                        let _ = window.hide();
                    } else {
                        let _ = window.unminimize();
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
            }
        })
        .build(app)?;

    // V3-P7 (V3-P6 carryover) — Reveal the main window now that chrome has
    // been applied. Configured `visible: false` so the prior code path
    // doesn't paint a one-frame native frame on Windows before
    // `set_decorations(false)` strips it. `show()` is instant: no animation
    // happens regardless of reduced-motion preference.
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
    }

    Ok(())
}

#[cfg(desktop)]
fn show_main_window<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}
