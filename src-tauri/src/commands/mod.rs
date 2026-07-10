//! Tauri command modules — the entire IPC surface callable from JS.
//!
//! Every command must also be listed in `generate_handler!` in `lib.rs`, under
//! a matching `#[cfg]`. The gates here are load-bearing: `identity` needs the
//! `keyring` crate (macOS/Windows only — Linux ships no keychain backend), and
//! the `desktop` modules use tray/shortcut/window APIs absent on mobile.
//! Getting a gate wrong silently drops a whole command group at compile time.

pub mod friends;
pub mod sessions;

#[cfg(any(target_os = "macos", target_os = "windows"))]
pub mod identity;

#[cfg(desktop)]
pub mod ai_dialog;

#[cfg(desktop)]
pub mod models;

#[cfg(desktop)]
pub mod sidecar;

#[cfg(desktop)]
pub mod system;
