mod commands;

#[cfg(any(target_os = "macos", target_os = "windows"))]
use commands::identity::{
    identity_exists, identity_load_keys, identity_load_record, identity_save_keys,
    identity_save_record, identity_sign,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_store::Builder::new().build());

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        identity_save_keys,
        identity_load_keys,
        identity_exists,
        identity_save_record,
        identity_load_record,
        identity_sign,
    ]);

    builder
        .setup(|app| {
            #[cfg(desktop)]
            {
                app.handle()
                    .plugin(tauri_plugin_global_shortcut::Builder::new().build())?;
                app.handle().plugin(tauri_plugin_autostart::init(
                    tauri_plugin_autostart::MacosLauncher::LaunchAgent,
                    None::<Vec<&str>>,
                ))?;
                #[cfg(not(debug_assertions))]
                app.handle()
                    .plugin(tauri_plugin_updater::Builder::new().build())?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
