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
    audit_event_insert, audit_events_list_for_session, sessions_insert, sessions_list,
};
#[cfg(desktop)]
use commands::sidecar::{sidecar_start, sidecar_status, sidecar_stop, SidecarState};
#[cfg(desktop)]
use commands::system::{
    autostart_is_enabled, autostart_set_enabled, system_battery,
    system_minimize_to_tray_set_enabled, system_open_data_folder, system_open_releases,
    system_open_screen_capture_settings, MinimizeToTrayFlag, QuitFlag,
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
        system_open_data_folder,
        #[cfg(desktop)]
        system_open_releases,
        #[cfg(desktop)]
        system_open_screen_capture_settings,
        #[cfg(desktop)]
        system_battery,
        #[cfg(desktop)]
        sidecar_start,
        #[cfg(desktop)]
        sidecar_stop,
        #[cfg(desktop)]
        sidecar_status,
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

#[cfg(desktop)]
fn setup_desktop(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    use std::str::FromStr;

    use tauri::{
        include_image,
        menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem},
        tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
        Emitter,
    };
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

    app.handle().plugin(tauri_plugin_autostart::init(
        tauri_plugin_autostart::MacosLauncher::LaunchAgent,
        None::<Vec<&str>>,
    ))?;

    // updater registration deferred to V3 — friends-only V1 ships without
    // auto-update; see V1-P12 scope decision.

    // `CmdOrCtrl` resolves to Cmd on macOS and Ctrl elsewhere via the
    // accelerator parser, which avoids the SUPER/META ambiguity in the
    // Modifiers bitflags. Comparing in the handler against the same parsed
    // Shortcut value is stable because the runtime fires events using the
    // exact Modifiers+Code we registered.
    let ptt_friends = Shortcut::from_str("CmdOrCtrl+[")?;
    let ptt_ai = Shortcut::from_str("CmdOrCtrl+]")?;

    let ptt_friends_handle = ptt_friends;
    let ptt_ai_handle = ptt_ai;
    app.handle().plugin(
        tauri_plugin_global_shortcut::Builder::new()
            .with_handler(move |app, shortcut, event| {
                if shortcut == &ptt_friends_handle {
                    match event.state() {
                        ShortcutState::Pressed => {
                            let _ = app.emit("ptt-friends-pressed", ());
                        }
                        ShortcutState::Released => {
                            let _ = app.emit("ptt-friends-released", ());
                        }
                    }
                } else if shortcut == &ptt_ai_handle {
                    // V2-P7 wires this shortcut to the floating Ctrl+] AI
                    // dialog window. Fire only on key-down so a press/release
                    // pair doesn't open then immediately close.
                    if event.state() == ShortcutState::Pressed {
                        if let Err(err) = toggle_ai_dialog(app) {
                            eprintln!("[ai-dialog] toggle failed: {err}");
                        }
                    }
                }
            })
            .build(),
    )?;
    app.global_shortcut()
        .register_multiple(vec![ptt_friends, ptt_ai])?;

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
