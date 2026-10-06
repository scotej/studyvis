use std::fs;
use std::path::{Path, PathBuf};

// Custom commands are denied to every webview unless a capability explicitly
// grants their generated `allow-*` permission. Keep this exhaustive with the
// `generate_handler!` table in `src/lib.rs`: an omitted command fails closed
// instead of silently becoming reachable from a secondary webview.
const APP_COMMANDS: &[&str] = &[
    "friends_list",
    "friends_add",
    "friends_remove",
    "friends_update_last_studied",
    "friends_get_x_pubkey",
    "friends_export",
    "friends_import",
    "sessions_insert",
    "sessions_insert_if_absent",
    "sessions_list",
    "sessions_get",
    "sessions_delete",
    "sessions_clear_all",
    "session_timeline_get",
    "session_timeline_save",
    "session_journal_append",
    "session_journal_read",
    "audit_event_insert",
    "audit_events_list_for_session",
    "audit_events_list_all",
    "identity_save_keys",
    "identity_exists",
    "identity_keys_present",
    "identity_save_record",
    "identity_load_record",
    "identity_sign",
    "identity_box_decrypt",
    "identity_box_encrypt",
    "autostart_set_enabled",
    "autostart_is_enabled",
    "system_minimize_to_tray_set_enabled",
    "system_ai_features_set_enabled",
    "system_open_data_folder",
    "system_write_text_file",
    "system_save_image",
    "system_open_releases",
    "system_open_screen_capture_settings",
    "system_open_camera_settings",
    "system_open_microphone_settings",
    "system_open_notification_settings",
    "system_set_global_shortcut",
    "system_relaunch_app",
    "system_install_context",
    "system_window_style_is_custom_applied",
    "system_battery",
    "session_set_active",
    "app_quit",
    "sidecar_start",
    "sidecar_stop",
    "sidecar_status",
    "engine_info",
    "engine_install",
    "diagnostics_reveal_log",
    "diagnostics_info",
    "diagnostics_export",
    "app_log_append",
    "app_log_tail",
    "ai_dialog_toggle",
    "session_overlay_prepare",
    "model_paths",
    "model_install_state",
    "model_remove",
    "model_head_check",
    "model_download",
    "model_download_cancel",
    "hf_token_save",
    "hf_token_present",
    "hf_token_clear",
];

fn main() {
    ensure_debug_sidecar_placeholder();
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(APP_COMMANDS)),
    )
    .expect("failed to generate Tauri command permissions");
}

// I73 — tauri-build hard-fails when the `externalBin` file is missing, which
// made scripts/fetch-llama-server.sh a manual prerequisite for every fresh
// checkout (cargo check/test/clippy included). For DEBUG-profile builds only,
// drop a tiny placeholder so the toolchain runs with zero setup; at runtime
// the engine auto-installer treats anything under its size gate as absent and
// downloads the real binary. Release-profile builds still fail loudly —
// CI/release fetch real binaries before cargo runs, and a placeholder must
// never ship inside an installer.
//
// Writing into src-tauri/binaries/ trips `tauri dev`'s file watcher once on a
// fresh checkout (observed: two extra rebuilds, then it settles because the
// file is never rewritten). A one-time cost, only where the fetch script was
// never run.
// Anything smaller cannot be a real llama-server (smallest prebuilt ~9 MB);
// mirrors MIN_REAL_ENGINE_BYTES in commands/engine.rs.
const PLACEHOLDER_CEILING_BYTES: u64 = 4 * 1024 * 1024;

fn ensure_debug_sidecar_placeholder() {
    let Ok(target) = std::env::var("TARGET") else {
        return;
    };
    let Ok(manifest_dir) = std::env::var("CARGO_MANIFEST_DIR") else {
        return;
    };
    let ext = if target.contains("windows") {
        ".exe"
    } else {
        ""
    };
    let path = PathBuf::from(&manifest_dir)
        .join("binaries")
        .join(format!("llama-server-{target}{ext}"));
    if std::env::var("PROFILE").as_deref() != Ok("debug") {
        // Release-profile arm: tauri-build only checks the file EXISTS, so a
        // placeholder left behind by an earlier debug build (gitignored —
        // invisible in `git status`) would bundle silently into a local
        // installer. Fail the build instead (PR-88 review).
        if let Ok(meta) = fs::metadata(&path) {
            if meta.len() < PLACEHOLDER_CEILING_BYTES {
                panic!(
                    "{} is a dev placeholder, not a real llama-server; run scripts/fetch-llama-server.sh before a release-profile build",
                    path.display()
                );
            }
        }
        if target == "x86_64-pc-windows-msvc" {
            let runtime_dir =
                PathBuf::from(&manifest_dir).join("binaries/llama-runtime-x86_64-pc-windows-msvc");
            let root_runtime_dir = PathBuf::from(&manifest_dir)
                .join("binaries/windows-vc-runtime-x86_64-pc-windows-msvc");
            for name in ["msvcp140.dll", "vcruntime140.dll", "vcruntime140_1.dll"] {
                let path = runtime_dir.join(name);
                let root_path = root_runtime_dir.join(name);
                for candidate in [&path, &root_path] {
                    if !is_x64_pe_dll(candidate) {
                        panic!(
                            "{} is missing or is not an AMD64 DLL; run scripts/stage-windows-vc-runtime.ps1 before a release-profile build",
                            candidate.display()
                        );
                    }
                }
                if fs::read(&path).ok() != fs::read(&root_path).ok() {
                    panic!(
                        "{} has inconsistent root and nested copies; run scripts/stage-windows-vc-runtime.ps1 before a release-profile build",
                        name
                    );
                }
            }
        }
        return;
    }
    // The resources glob `binaries/llama-runtime-*/*` ALSO hard-fails when
    // nothing matches (a truly fresh checkout has neither the binary nor the
    // runtime dir — both gitignored), so the placeholder must cover both.
    // The marker file inside is inert: resolve_runtime_dir only prepends the
    // dir to the library search path, and the fetch script overwrites the
    // whole dir when it runs.
    let runtime_dir = path
        .parent()
        .expect("binaries dir has a parent")
        .join(format!("llama-runtime-{target}"));
    if !runtime_dir.exists() {
        let _ = fs::create_dir_all(&runtime_dir);
        let _ = fs::write(
            runtime_dir.join("PLACEHOLDER-README.txt"),
            b"studyvis placeholder: real companion libraries come from scripts/fetch-llama-server.sh or the in-app engine auto-install (I73)\n",
        );
    }
    // The Windows app-local resource mappings must also exist in fresh debug
    // checkouts; release workflows replace these with verified Microsoft DLLs.
    if target == "x86_64-pc-windows-msvc" {
        let root_runtime_dir =
            PathBuf::from(&manifest_dir).join("binaries/windows-vc-runtime-x86_64-pc-windows-msvc");
        let _ = fs::create_dir_all(&root_runtime_dir);
        for directory in [&runtime_dir, &root_runtime_dir] {
            for name in ["msvcp140.dll", "vcruntime140.dll", "vcruntime140_1.dll"] {
                let path = directory.join(name);
                if !path.exists() {
                    let _ = fs::write(
                        path,
                        b"studyvis debug placeholder: run scripts/stage-windows-vc-runtime.ps1 before bundling\n",
                    );
                }
            }
        }
    }
    if path.exists() {
        return;
    }
    let _ = fs::create_dir_all(path.parent().expect("binaries dir has a parent"));
    let _ = fs::write(
        &path,
        b"studyvis placeholder: the real llama-server comes from scripts/fetch-llama-server.sh or the in-app engine auto-install (I73)\n",
    );
}

fn is_x64_pe_dll(path: &Path) -> bool {
    let Ok(bytes) = fs::read(path) else {
        return false;
    };
    let Some(dos_header) = bytes.get(..64) else {
        return false;
    };
    if !dos_header.starts_with(b"MZ") {
        return false;
    }
    let pe_offset = u32::from_le_bytes(dos_header[60..64].try_into().unwrap()) as usize;
    let Some(header) = bytes.get(pe_offset..pe_offset.saturating_add(26)) else {
        return false;
    };
    let optional_size = u16::from_le_bytes([header[20], header[21]]) as usize;
    header.starts_with(b"PE\0\0")
        && header[4..6] == [0x64, 0x86]
        && header[23] & 0x20 != 0
        && header[24..26] == [0x0b, 0x02]
        && optional_size >= 112
        && bytes
            .get(pe_offset.saturating_add(24)..pe_offset.saturating_add(24 + optional_size))
            .is_some()
}
