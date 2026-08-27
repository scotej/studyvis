//! Tauri command modules — the entire IPC surface callable from JS.
//!
//! Every command must also be listed in `generate_handler!` in `lib.rs`, under
//! a matching `#[cfg]`. The gates here are load-bearing: `identity` needs the
//! platform-specific `keyring` backend (including Secret Service on Linux),
//! and the `desktop` modules use tray/shortcut/window APIs absent on mobile.
//! Getting a gate wrong silently drops a whole command group at compile time.

pub mod friends;
// #236 — the raw observation journal is a plain file beside the database, so
// it needs no platform backend and stays ungated like `sessions` itself.
pub mod session_journal;
pub mod sessions;

#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
pub mod identity;

#[cfg(desktop)]
pub mod ai_dialog;

#[cfg(desktop)]
pub mod applog;

#[cfg(desktop)]
pub mod compute_device;

#[cfg(desktop)]
pub mod diagnostics;

#[cfg(desktop)]
pub mod engine;

// Only the macOS physical-key watcher in `system` publishes a level; gating the
// module to its single consumer keeps it off the Windows/Linux legs entirely.
#[cfg(target_os = "macos")]
mod level_confirmation;

// Platform-neutral on purpose, unlike `level_confirmation`: every desktop leg
// records session and shortcut lifecycle, so its tests run on all three.
#[cfg(desktop)]
pub mod native_log;

#[cfg(desktop)]
pub mod models;

#[cfg(desktop)]
pub mod sidecar;

#[cfg(desktop)]
pub mod system;
