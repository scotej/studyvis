//! Floating Ctrl+] AI dialog window (V2-P7).
//!
//! The PTT-AI shortcut handler calls `toggle_ai_dialog` which either
//! creates the second WebviewWindow (transparent, alwaysOnTop, no
//! decorations, skipTaskbar, focused) or destroys the existing one. The
//! macOS-only branch sets the NSWindowCollectionBehavior to
//! `canJoinAllSpaces | fullScreenAuxiliary` so the dialog appears over
//! fullscreen apps (ARCHITECTURE.md §12).
//!
//! Transparent windows on macOS require `app.macOSPrivateApi: true` in
//! tauri.conf.json. That flag locks the app out of the Mac App Store, but
//! V1's friends-only distribution (PLAN.md §5) already retired that path.

use tauri::{AppHandle, Manager, Runtime, WebviewUrl, WebviewWindowBuilder};

/// Label for the dialog webview. Referenced from `lib.rs` (quit teardown) and
/// `system.rs` (AI-features-off teardown), and scoped by
/// `capabilities/ai-dialog.json` — renaming it breaks all three.
pub const AI_DIALOG_LABEL: &str = "ai-dialog";

const DIALOG_WIDTH: f64 = 460.0;
const DIALOG_HEIGHT: f64 = 220.0;

/// Toggles the dialog: destroys it if already open, otherwise creates it.
/// `destroy()` rather than `close()` because a toggle wants immediate,
/// unconditional teardown — `close()` goes through the asynchronous
/// close-requested roundtrip (interceptable machinery this window doesn't
/// need; `lib.rs`'s handler only acts on the `main` window anyway). Not a
/// `#[tauri::command]` — invoked from the global-shortcut handler in
/// `lib.rs`, which `let _ =`-captures the Result to keep the app responsive
/// on builder failure.
pub fn toggle_ai_dialog<R: Runtime>(app: &AppHandle<R>) -> Result<(), tauri::Error> {
    if let Some(existing) = app.get_webview_window(AI_DIALOG_LABEL) {
        existing.destroy()?;
        return Ok(());
    }

    let url = WebviewUrl::App("ai-dialog.html".into());
    let mut builder = WebviewWindowBuilder::new(app, AI_DIALOG_LABEL, url)
        .title("StudyVis · Ask the AI")
        .inner_size(DIALOG_WIDTH, DIALOG_HEIGHT)
        .center()
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(true)
        .resizable(false);

    // Hide the dock icon entry for the dialog on macOS — `skip_taskbar`
    // covers Windows; on macOS the same flag maps to the dock surface.
    #[cfg(target_os = "macos")]
    {
        // Setting visible_on_all_workspaces gives us the canJoinAllSpaces
        // bit via tao, but it also OR's in transient+stationary which we
        // override below. We set it here for parity on the off-chance
        // the AppKit cast fails — better to show on all spaces than to
        // get stuck on one.
        builder = builder.visible_on_all_workspaces(true);
    }

    let window = builder.build()?;

    // macOS: extend collection behavior with FullScreenAuxiliary so the
    // dialog appears over fullscreen apps. tao set
    // canJoinAllSpaces+transient+stationary via the builder; we OR in
    // FullScreenAuxiliary on top.
    #[cfg(target_os = "macos")]
    {
        apply_macos_collection_behavior(&window);
    }

    // Silence unused-mut on non-macOS builds where the second branch is gone.
    #[cfg(not(target_os = "macos"))]
    {
        let _ = &window;
    }

    Ok(())
}

#[cfg(target_os = "macos")]
fn apply_macos_collection_behavior<R: Runtime>(window: &tauri::WebviewWindow<R>) {
    use objc2::rc::Retained;
    use objc2_app_kit::{NSWindow, NSWindowCollectionBehavior};

    let raw = match window.ns_window() {
        Ok(ptr) if !ptr.is_null() => ptr,
        _ => {
            eprintln!("[ai-dialog] ns_window() returned null — collection behavior unchanged");
            return;
        }
    };
    unsafe {
        // ns_window() returns an autoreleased pointer (per
        // tauri::WebviewWindow::ns_window docs / source). Wrap it back
        // into a Retained so the AppKit method dispatch sees a proper
        // NSWindow reference; the Retained drops at end of scope which
        // matches the autoreleased ownership.
        let ns_window: Retained<NSWindow> =
            Retained::retain(raw as *mut NSWindow).expect("ns_window pointer to be non-null");
        let mut behavior = ns_window.collectionBehavior();
        behavior |= NSWindowCollectionBehavior::CanJoinAllSpaces;
        behavior |= NSWindowCollectionBehavior::FullScreenAuxiliary;
        ns_window.setCollectionBehavior(behavior);
    }
}
