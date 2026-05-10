mod commands;
pub mod crypto;
pub mod db;

use tauri::Manager;

use commands::friends::{
    friends_add, friends_get_x_pubkey, friends_list, friends_remove, friends_update_last_studied,
};
use commands::sessions::{audit_event_insert, sessions_insert, sessions_list};
#[cfg(any(target_os = "macos", target_os = "windows"))]
use commands::identity::{
    identity_box_decrypt, identity_box_encrypt, identity_exists, identity_load_record,
    identity_save_keys, identity_save_record, identity_sign,
};
#[cfg(desktop)]
use commands::system::{
    autostart_is_enabled, autostart_set_enabled, system_minimize_to_tray_set_enabled,
    system_open_data_folder, system_open_releases, MinimizeToTrayFlag, QuitFlag,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_opener::init());

    #[cfg(all(desktop, any(target_os = "macos", target_os = "windows")))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        friends_list,
        friends_add,
        friends_remove,
        friends_update_last_studied,
        friends_get_x_pubkey,
        sessions_insert,
        sessions_list,
        audit_event_insert,
        identity_save_keys,
        identity_exists,
        identity_save_record,
        identity_load_record,
        identity_sign,
        identity_box_decrypt,
        identity_box_encrypt,
        autostart_set_enabled,
        autostart_is_enabled,
        system_minimize_to_tray_set_enabled,
        system_open_data_folder,
        system_open_releases,
    ]);

    #[cfg(all(desktop, not(any(target_os = "macos", target_os = "windows"))))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        friends_list,
        friends_add,
        friends_remove,
        friends_update_last_studied,
        friends_get_x_pubkey,
        sessions_insert,
        sessions_list,
        audit_event_insert,
        autostart_set_enabled,
        autostart_is_enabled,
        system_minimize_to_tray_set_enabled,
        system_open_data_folder,
        system_open_releases,
    ]);

    #[cfg(not(desktop))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        friends_list,
        friends_add,
        friends_remove,
        friends_update_last_studied,
        friends_get_x_pubkey,
        sessions_insert,
        sessions_list,
        audit_event_insert,
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

    builder
        .setup(|app| {
            let pool = db::init(&app.handle()).map_err(|e| -> Box<dyn std::error::Error> {
                format!("db init: {e}").into()
            })?;
            app.manage(pool);

            #[cfg(desktop)]
            {
                app.manage(QuitFlag::new());
                app.manage(MinimizeToTrayFlag::new());
                setup_desktop(app)?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
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
                    // V1: PTT-AI is registered so the keybinding is reserved
                    // on the user's machine, but no handler exists yet — V2-P7
                    // wires this to the floating AI dialog window.
                    if event.state() == ShortcutState::Pressed {
                        log_ptt_ai_noop();
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

#[cfg(desktop)]
fn log_ptt_ai_noop() {
    eprintln!("ptt-ai shortcut fired (V1 no-op; V2-P7 wires AI dialog)");
}
