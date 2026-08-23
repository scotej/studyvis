//! Linux boot-environment capture and web-process crash recovery (#263).
//!
//! Issue #263 reports a fully-white window on CachyOS: the WebKitGTK web
//! process dies around launch/join and the page never renders again. Until
//! now nothing about that landed anywhere a user could attach to a bug
//! report, and nothing brought the view back.
//!
//! Two halves, both Linux-only:
//!
//! 1. [`capture_boot_environment`] records the session/display facts a white
//!    screen is diagnosed from — session type, desktop classification,
//!    display-server backend, packaged runtime payload presence, WebKitGTK
//!    version — through the shared structured log (`native_log`, so the
//!    records ride `studyvis.log`, roll with it, and end up in the Settings
//!    diagnostics archive) and mirrors every line to stderr for
//!    terminal/AppImage launches where the data dir may itself be the
//!    problem. Values follow `native_log`'s closed-domain rule: free-form
//!    environment strings are classified into fixed words, presence-only
//!    booleans, or counts. Nothing address-like (`$DISPLAY`,
//!    `$DBUS_SESSION_BUS_ADDRESS`) is ever recorded.
//!
//! 2. [`install_crash_recovery`] answers WebKitGTK's `web-process-terminated`
//!    signal on the main webview: log the reason, then reload the page while
//!    under the retry budget. This converts #263's permanent white window
//!    into a self-recovering view whose cause is still fully logged. The
//!    budget is deliberately small — two automatic reloads — because an
//!    environment that kills the web process instantly (missing GPU/portal
//!    stack) would otherwise spin forever; after the budget the app stays
//!    down but every attempt is in the log.

use tauri::{Manager, Runtime};
use webkit2gtk::{WebProcessTerminationReason, WebViewExt};

/// Automatic page reloads per process lifetime once the web process dies.
const RELOAD_BUDGET: u32 = 2;

// ---------------------------------------------------------------------------
// Closed-value classifiers. Free-form environment strings must become one of
// these fixed words before they reach the log — see native_log's module docs
// for why no raw String ever crosses this boundary.
// ---------------------------------------------------------------------------

fn classify_session_type(value: Option<String>) -> &'static str {
    match value.as_deref() {
        Some(v) if v.eq_ignore_ascii_case("wayland") => "wayland",
        Some(v) if v.eq_ignore_ascii_case("x11") => "x11",
        Some(_) => "other",
        None => "unset",
    }
}

fn classify_desktop(value: Option<String>) -> &'static str {
    // XDG_CURRENT_DESKTOP is a colon-separated priority list ("KDE:GNOME"):
    // the leftmost entry is the session's primary desktop, so positions are
    // checked in list order, not in the known-names order.
    const KNOWN: [&str; 8] = [
        "gnome", "kde", "cosmic", "hyprland", "xfce", "mate", "cinnamon", "lxqt",
    ];
    let Some(raw) = value else {
        return "unset";
    };
    let lowered = raw.to_ascii_lowercase();
    if lowered.trim().is_empty() {
        return "empty";
    }
    for part in lowered.split(':') {
        let part = part.trim();
        if let Some(known) = KNOWN.iter().find(|known| *known == &part) {
            return known;
        }
    }
    "other"
}

fn classify_gdk_backend(value: Option<String>) -> &'static str {
    let Some(raw) = value else {
        return "unset";
    };
    let lowered = raw.to_ascii_lowercase();
    // GDK tries backends left-to-right, so the first named one wins.
    if lowered
        .split(',')
        .next()
        .is_some_and(|first| first.trim() == "wayland")
    {
        "prefers-wayland"
    } else if lowered
        .split(',')
        .next()
        .is_some_and(|first| first.trim() == "x11")
    {
        "prefers-x11"
    } else if lowered.trim().is_empty() {
        "empty"
    } else {
        "other"
    }
}

fn termination_reason_word(reason: WebProcessTerminationReason) -> &'static str {
    // The enum is #[non_exhaustive]: future WebKit reasons land as new
    // variants here only after a crate bump, so the wildcard keeps this
    // compiling across upgrades instead of inventing unknowns.
    match reason {
        WebProcessTerminationReason::Crashed => "crashed",
        WebProcessTerminationReason::ExceededMemoryLimit => "exceeded_memory_limit",
        WebProcessTerminationReason::TerminatedByApi => "terminated_by_api",
        _ => "unknown",
    }
}

/// Whether a terminated web process gets another chance, given how many
/// automatic reloads already happened. `TerminatedByApi` is the embedder's
/// own doing (never StudyVis's today) and is never retried.
fn should_reload(reason: WebProcessTerminationReason, attempts_so_far: u32) -> bool {
    reason != WebProcessTerminationReason::TerminatedByApi && attempts_so_far < RELOAD_BUDGET
}

// ---------------------------------------------------------------------------
// Recording. Mirrors native_log's producer shape but always also echoes to
// stderr: the boot environment is exactly what you need when the log
// directory itself is unreachable, and AppImage terminal launches show stderr.
// ---------------------------------------------------------------------------

fn echo(
    level: &str,
    msg: &str,
    fields: &[(&'static str, crate::commands::native_log::NativeValue)],
) {
    let mut line = format!("[boot:{level}] {msg}");
    for (key, value) in fields {
        let mut rendered = String::new();
        value.render_into(&mut rendered);
        line.push_str(&format!(" {key}={rendered}"));
    }
    eprintln!("{line}");
}

fn record(msg: &'static str, fields: &[(&'static str, crate::commands::native_log::NativeValue)]) {
    echo("info", msg, fields);
    crate::commands::native_log::record(
        crate::commands::native_log::NativeLevel::Info,
        "boot",
        msg,
        fields,
    );
}

fn word(v: &'static str) -> crate::commands::native_log::NativeValue {
    crate::commands::native_log::NativeValue::Word(v)
}

fn flag(present: bool) -> crate::commands::native_log::NativeValue {
    crate::commands::native_log::NativeValue::Bool(present)
}

fn u64_value(v: u64) -> crate::commands::native_log::NativeValue {
    crate::commands::native_log::NativeValue::U64(v)
}

// ---------------------------------------------------------------------------
// Boot environment facts.
// ---------------------------------------------------------------------------

/// Records the display/desktop facts and packaged-payload detection. Must run
/// after `native_log::init` (so records reach the file) and before the webview
/// starts (so a crash during startup still has its environment on record).
pub fn capture_boot_environment() {
    let session_type = classify_session_type(std::env::var("XDG_SESSION_TYPE").ok());
    record("boot.session_type", &[("value", word(session_type))]);
    record(
        "boot.desktop",
        &[
            (
                "current",
                word(classify_desktop(std::env::var("XDG_CURRENT_DESKTOP").ok())),
            ),
            (
                "session",
                word(classify_desktop(std::env::var("XDG_SESSION_DESKTOP").ok())),
            ),
        ],
    );
    record(
        "boot.gdk_backend",
        &[(
            "value",
            word(classify_gdk_backend(std::env::var("GDK_BACKEND").ok())),
        )],
    );
    record(
        "boot.display_server",
        &[
            // Presence only: $DISPLAY/$WAYLAND_DISPLAY are socket addresses.
            ("x11", flag(std::env::var_os("DISPLAY").is_some())),
            (
                "wayland",
                flag(std::env::var_os("WAYLAND_DISPLAY").is_some()),
            ),
        ],
    );

    // GStreamer/PipeWire relocation env the packaged runtime sets (I89). The
    // values are absolute paths; presence is the diagnostic, not the path.
    record(
        "boot.media_env",
        &[
            (
                "gst_plugin_system_path",
                flag(std::env::var_os("GST_PLUGIN_SYSTEM_PATH").is_some()),
            ),
            (
                "spa_plugin_dir",
                flag(std::env::var_os("SPA_PLUGIN_DIR").is_some()),
            ),
            (
                "pipewire_module_dir",
                flag(std::env::var_os("PIPEWIRE_MODULE_DIR").is_some()),
            ),
            (
                "pipewire_config_dir",
                flag(std::env::var_os("PIPEWIRE_CONFIG_DIR").is_some()),
            ),
        ],
    );

    record_packaged_payloads();

    let versions = webkit_version_components();
    record(
        "boot.webkitgtk",
        &[
            ("major", u64_value(versions.0)),
            ("minor", u64_value(versions.1)),
            ("micro", u64_value(versions.2)),
        ],
    );
    record(
        "boot.target",
        &[
            ("os", word(std::env::consts::OS)),
            ("arch", word(std::env::consts::ARCH)),
            (
                "family",
                word(if std::env::consts::FAMILY.is_empty() {
                    "unknown"
                } else {
                    std::env::consts::FAMILY
                }),
            ),
        ],
    );
}

/// WebKitGTK runtime version as (major, minor, micro). The symbols exist
/// wherever WebKitGTK links, so there is no failure branch to model.
fn webkit_version_components() -> (u64, u64, u64) {
    unsafe {
        (
            webkit2gtk::ffi::webkit_get_major_version() as u64,
            webkit2gtk::ffi::webkit_get_minor_version() as u64,
            webkit2gtk::ffi::webkit_get_micro_version() as u64,
        )
    }
}

fn record_packaged_payloads() {
    // Same layout assumption as linux_pipewire_runtime::packaged_prefix:
    // <prefix>/usr/bin/studyvis inside the mounted AppImage. A source or
    // `tauri dev` build has nothing beside the executable and reports absent,
    // which is the true statement there.
    let prefix = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent()?.parent().map(|p| p.join("usr")));

    let webkit_runtime = prefix.as_ref().map(|p| p.join("studyvis-webkit-runtime"));
    record(
        "boot.packaged_webkit_runtime",
        &[
            (
                "present",
                flag(webkit_runtime.as_ref().is_some_and(|p| p.is_dir())),
            ),
            (
                "web_process",
                flag(
                    webkit_runtime
                        .as_ref()
                        .is_some_and(|p| p.join("processes/WebProcess").is_file()),
                ),
            ),
            (
                "sandbox_bwrap",
                flag(
                    webkit_runtime
                        .as_ref()
                        .is_some_and(|p| p.join("sandbox/bwrap").is_file()),
                ),
            ),
        ],
    );

    let pipewire = prefix.as_ref().map(|p| {
        (
            p.join("lib/spa-0.2"),
            p.join("lib/libpipewire-module-protocol-native.so"),
            p.join("share/pipewire"),
        )
    });
    if let Some((spa, modules_marker, config)) = pipewire {
        record(
            "boot.packaged_pipewire",
            &[
                ("spa_plugins", flag(spa.is_dir())),
                ("protocol_native_module", flag(modules_marker.is_file())),
                ("config", flag(config.is_dir())),
            ],
        );
    } else {
        record(
            "boot.packaged_pipewire",
            &[
                ("spa_plugins", flag(false)),
                ("protocol_native_module", flag(false)),
                ("config", flag(false)),
            ],
        );
    }
}

// ---------------------------------------------------------------------------
// Web-process crash visibility + bounded recovery.
// ---------------------------------------------------------------------------

/// Installs the `web-process-terminated` hook on the main webview. Follows
/// `linux_media_permissions::install`: resolve the window, drop to the native
/// WebView through `with_webview`, attach one signal handler.
pub fn install_crash_recovery<R: Runtime>(app: &tauri::AppHandle<R>) {
    static ATTEMPTS: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

    let Some(window) = app.get_webview_window("main") else {
        eprintln!("[boot:error] no main window; web-process crash recovery not installed");
        return;
    };

    if let Err(error) = window.with_webview(move |platform_webview| {
        platform_webview
            .inner()
            .connect_web_process_terminated(move |_webview, reason| {
                let attempts = ATTEMPTS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                let retry = should_reload(reason, attempts);
                record(
                    "webproc.terminated",
                    &[
                        ("reason", word(termination_reason_word(reason))),
                        ("attempt", u64_value(attempts as u64 + 1)),
                        ("recovery", word(if retry { "reload" } else { "give_up" })),
                    ],
                );
                if retry {
                    _webview.reload();
                }
            });
    }) {
        eprintln!("[boot:error] with_webview failed; crash recovery not installed: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_type_is_classified_not_copied() {
        assert_eq!(classify_session_type(Some("wayland".into())), "wayland");
        assert_eq!(classify_session_type(Some("Wayland".into())), "wayland");
        assert_eq!(classify_session_type(Some("x11".into())), "x11");
        assert_eq!(classify_session_type(Some("tty".into())), "other");
        assert_eq!(classify_session_type(None), "unset");
    }

    #[test]
    fn desktop_classification_reads_the_priority_list() {
        assert_eq!(classify_desktop(Some("KDE".into())), "kde");
        assert_eq!(classify_desktop(Some("ubuntu:GNOME".into())), "gnome");
        assert_eq!(
            classify_desktop(Some("GNOME-Flashback:GNOME".into())),
            "gnome"
        );
        assert_eq!(classify_desktop(Some("KDE:GNOME".into())), "kde");
        assert_eq!(classify_desktop(Some("CachyOS".into())), "other");
        assert_eq!(classify_desktop(Some("".into())), "empty");
        assert_eq!(classify_desktop(None), "unset");
    }

    #[test]
    fn desktop_classification_never_matches_a_substring() {
        // "X-Generic" must not match "x…" style accidents; parts compare whole.
        assert_eq!(classify_desktop(Some("gnomeish".into())), "other");
        assert_eq!(classify_desktop(Some("KDE-Connect".into())), "other");
    }

    #[test]
    fn gdk_backend_reports_the_first_preference() {
        assert_eq!(
            classify_gdk_backend(Some("wayland,x11".into())),
            "prefers-wayland"
        );
        assert_eq!(
            classify_gdk_backend(Some("x11,wayland".into())),
            "prefers-x11"
        );
        assert_eq!(classify_gdk_backend(Some("".into())), "empty");
        assert_eq!(classify_gdk_backend(Some("broadway".into())), "other");
        assert_eq!(classify_gdk_backend(None), "unset");
    }

    #[test]
    fn termination_reason_maps_to_fixed_words() {
        assert_eq!(
            termination_reason_word(WebProcessTerminationReason::Crashed),
            "crashed"
        );
        assert_eq!(
            termination_reason_word(WebProcessTerminationReason::ExceededMemoryLimit),
            "exceeded_memory_limit"
        );
        assert_eq!(
            termination_reason_word(WebProcessTerminationReason::__Unknown(99)),
            "unknown"
        );
    }

    #[test]
    fn reload_budget_is_two_and_api_termination_never_retries() {
        assert!(should_reload(WebProcessTerminationReason::Crashed, 0));
        assert!(should_reload(WebProcessTerminationReason::Crashed, 1));
        assert!(!should_reload(WebProcessTerminationReason::Crashed, 2));
        assert!(!should_reload(
            WebProcessTerminationReason::ExceededMemoryLimit,
            2
        ));
        assert!(!should_reload(
            WebProcessTerminationReason::TerminatedByApi,
            0
        ));
    }

    #[test]
    fn webkit_version_symbols_resolve_without_a_display() {
        let (major, minor, micro) = webkit_version_components();
        // Any real WebKitGTK answers; 0.0.0 would mean the symbols vanished.
        assert!(major > 0, "webkit_get_major_version returned {major}");
        let _ = (minor, micro);
    }
}
