//! Packaged PipeWire search paths.
//!
//! The AppImage carries `libpipewire-0.3.so.0` because `libgstpipewire.so`
//! declares it in DT_NEEDED, but PipeWire opens its SPA plugins, its context
//! modules, and its client configuration by name at runtime. Those lookups use
//! paths compiled into the library at build time, which on the Ubuntu builder
//! are `/usr/lib/x86_64-linux-gnu/...` — absolute host paths that do not exist
//! on any distribution that is not Debian-derived, and that an AppImage never
//! remaps. `pw_loop_new()` then returns NULL and GStreamer dereferences it,
//! killing the web process seconds after launch (ISSUES.md I89).
//!
//! PipeWire's own environment overrides are the documented way to relocate
//! those three lookups, so the packaged payload is declared here, relative to
//! the running executable, exactly as the WebKit portability patch resolves
//! its subprocesses. A source or `tauri dev` build has no payload beside its
//! executable and is left untouched, as is anything the user set themselves.

use std::path::{Path, PathBuf};

/// Points the packaged PipeWire client at the packaged payload.
///
/// Must run before the webview starts: WebKit's web process inherits this
/// environment, and it is the process that loads GStreamer's PipeWire plugin.
pub fn install() {
    let Some(prefix) = packaged_prefix() else {
        return;
    };

    let spa = prefix.join("lib/spa-0.2");
    // The modules sit beside libpipewire rather than in their own directory:
    // client-node declares protocol-native in DT_NEEDED, and the loader never
    // searches a consumer's own directory, so a nested layout would resolve
    // only by accident of the order client.conf happens to load them in.
    let modules = prefix.join("lib");
    let config = prefix.join("share/pipewire");

    // Every entry in the packaged client.conf is a mandatory module, so a
    // partially present payload cannot work. Leaving the variables unset there
    // keeps the failure at PipeWire's own "module not found" diagnostic
    // instead of pointing it at a directory that is missing half its contents.
    if !spa.is_dir()
        || !config.is_dir()
        || !modules
            .join("libpipewire-module-protocol-native.so")
            .is_file()
    {
        return;
    }

    set_if_unset("SPA_PLUGIN_DIR", &spa);
    set_if_unset("PIPEWIRE_MODULE_DIR", &modules);
    set_if_unset("PIPEWIRE_CONFIG_DIR", &config);
}

/// `/usr` inside the mounted AppImage, from `/usr/bin/studyvis`.
fn packaged_prefix() -> Option<PathBuf> {
    let executable = std::env::current_exe().ok()?;
    Some(executable.parent()?.parent()?.to_path_buf())
}

fn set_if_unset(name: &str, value: &Path) {
    if std::env::var_os(name).is_none() {
        std::env::set_var(name, value);
    }
}
