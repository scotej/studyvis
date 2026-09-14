//! Native preparation for the transient in-session overlay window.
//!
//! The overlay is a second WebviewWindow that `sessionOverlayRuntime.ts`
//! creates from the main webview with `alwaysOnTop` and
//! `visibleOnAllWorkspaces`, which tao maps to the floating level plus
//! `canJoinAllSpaces`. macOS additionally requires `fullScreenAuxiliary`
//! before a window may join another app's full-screen Space, and Tauri's
//! window config cannot express that bit — so the overlay never appeared
//! while a macOS user was in a full-screen app (#317, I118). The runtime calls
//! this command once, between creation and the first reveal. It targets the
//! overlay label only, so the main window cannot retarget it.

use tauri::{AppHandle, Manager, Runtime};

/// Label of the overlay webview. Scoped by `capabilities/session-overlay.json`
/// and mirrored by `SESSION_OVERLAY_WINDOW_LABEL` in `sessionOverlay.ts` —
/// renaming it breaks all three.
pub const SESSION_OVERLAY_LABEL: &str = "session-overlay";

/// Applies the platform behavior the overlay cannot request through its
/// window options. A no-op that still verifies the window exists on Windows
/// and Linux, so the JS contract is identical on every desktop.
#[tauri::command]
pub fn session_overlay_prepare<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    let Some(window) = app.get_webview_window(SESSION_OVERLAY_LABEL) else {
        return Err("session overlay window is not open".to_owned());
    };
    #[cfg(target_os = "macos")]
    {
        crate::macos_floating_window::apply_collection_behavior(&window)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = window;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::SESSION_OVERLAY_LABEL;

    #[test]
    fn label_matches_the_capability_scope() {
        let capability = include_str!("../../capabilities/session-overlay.json");
        assert!(
            capability.contains(&format!("\"windows\": [\"{SESSION_OVERLAY_LABEL}\"]")),
            "capabilities/session-overlay.json must scope exactly the overlay label"
        );
    }
}
