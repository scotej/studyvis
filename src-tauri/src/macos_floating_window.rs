//! AppKit collection behavior shared by StudyVis's floating windows (the
//! Ctrl+] AI dialog and the in-session overlay).
//!
//! tao maps `visible_on_all_workspaces(true)` to `canJoinAllSpaces` alone.
//! macOS also needs `fullScreenAuxiliary` before a window may appear on the
//! same Space as another app's full-screen window; without it a floating,
//! all-Spaces window is simply absent while the user is in a full-screen app
//! (ARCHITECTURE.md §12). Tauri's window builder and config do not expose the
//! bit, so both windows apply it here after construction.

use objc2::rc::Retained;
use objc2_app_kit::{NSWindow, NSWindowCollectionBehavior};
use tauri::Runtime;

/// ORs `canJoinAllSpaces | fullScreenAuxiliary` into the window's existing
/// collection behavior. Every bit tao already set is kept.
pub(crate) fn apply_collection_behavior<R: Runtime>(
    window: &tauri::WebviewWindow<R>,
) -> Result<(), String> {
    let raw = match window.ns_window() {
        Ok(ptr) if !ptr.is_null() => ptr,
        _ => return Err("ns_window() returned null".to_owned()),
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
    Ok(())
}
