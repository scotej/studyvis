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
use webkit2gtk::gio::{BusType, DBusCallFlags};
use webkit2gtk::glib::ToVariant;
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

    // GStreamer/PipeWire relocation env. GStreamer's own AppRun hook (and
    // check-linux-appimage.sh's smoke, which mirrors it) exports only the
    // 1_0-suffixed GST variants; the app itself sets the three PipeWire
    // variables in linux_pipewire_runtime::install before any webview exists.
    // The values are absolute paths; presence is the diagnostic, not the path.
    record(
        "boot.media_env",
        &[
            (
                "gst_plugin_system_path_1_0",
                flag(std::env::var_os("GST_PLUGIN_SYSTEM_PATH_1_0").is_some()),
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
    // The AppImage executes /<mount>/usr/bin/studyvis, so the executable's
    // grandparent is <mount>/usr itself — the same derivation
    // linux_pipewire_runtime::packaged_prefix performs. A source or
    // `tauri dev` build has nothing beside the executable and reports absent,
    // which is the true statement there.
    let usr = std::env::current_exe()
        .ok()
        .as_deref()
        .and_then(|exe| exe.parent()?.parent().map(|p| p.to_path_buf()));

    // Staged names come from src-tauri/tauri.linux.conf.json: the WebKit
    // processes sit directly in bin/studyvis-webkit-runtime and the bwrap
    // helper in bin/ — there is no processes/ or sandbox/ subdirectory in the
    // shipped image. scripts/check-linux-appimage.sh validates the same
    // locations, so these probes stay honest (unit-pinned below).
    let webkit = usr.as_deref().map(packaged_webkit_probes);
    record(
        "boot.packaged_webkit_runtime",
        &[
            (
                "present",
                flag(webkit.as_ref().is_some_and(|(dir, _, _)| dir.is_dir())),
            ),
            (
                "web_process",
                flag(
                    webkit
                        .as_ref()
                        .is_some_and(|(_, web_process, _)| web_process.is_file()),
                ),
            ),
            (
                "sandbox_bwrap",
                flag(webkit.as_ref().is_some_and(|(_, _, bwrap)| bwrap.is_file())),
            ),
        ],
    );

    let pipewire = usr.as_ref().map(|u| {
        (
            u.join("lib/spa-0.2"),
            u.join("lib/libpipewire-module-protocol-native.so"),
            u.join("share/pipewire"),
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

// Pure so the packaged-layout contract is unit-testable without a filesystem.
// Order: (runtime dir, web process, bwrap). Paths mirror
// src-tauri/tauri.linux.conf.json's bundle files and
// scripts/check-linux-appimage.sh's validated locations exactly.
fn packaged_webkit_probes(
    usr: &std::path::Path,
) -> (std::path::PathBuf, std::path::PathBuf, std::path::PathBuf) {
    let runtime = usr.join("bin/studyvis-webkit-runtime");
    (
        runtime.clone(),
        runtime.join("WebKitWebProcess"),
        usr.join("bin/bwrap"),
    )
}

// ---------------------------------------------------------------------------
// Tray-host presence. tray-icon's Linux constructor builds an AppIndicator
// and returns Ok even when no StatusNotifier host exists on the session bus —
// the icon simply never renders (the #263 GNOME outcome). Construction
// success therefore says nothing about reachability, so close-to-tray is
// gated on this DBus check instead: libappindicator's StatusNotifierItem
// protocol requires a watcher (org.kde.StatusNotifierWatcher) that reports a
// registered host before any indicator can appear.
// ---------------------------------------------------------------------------

/// Whether the session bus reports an owner for
/// `org.kde.StatusNotifierWatcher`. A missing or unreachable bus counts as
/// absent: without D-Bus there is no StatusNotifier protocol at all.
pub fn status_notifier_watcher_owned() -> bool {
    dbus_name_has_owner("org.kde.StatusNotifierWatcher")
}

fn dbus_name_has_owner(name: &str) -> bool {
    let Ok(connection) =
        webkit2gtk::gio::bus_get_sync(BusType::Session, None::<&webkit2gtk::gio::Cancellable>)
    else {
        return false;
    };
    connection
        .call_sync(
            Some("org.freedesktop.DBus"),
            "/org/freedesktop/DBus",
            "org.freedesktop.DBus",
            "NameHasOwner",
            // D-Bus method arguments always travel as a tuple.
            Some(&webkit2gtk::glib::Variant::tuple_from_iter([
                name.to_variant()
            ])),
            // The reply is '(b)': GDBus wraps every method reply in a tuple,
            // so pinning BOOLEAN here rejects every answer ("returned type
            // '(b)', but expected 'b'"). Read the tuple child instead.
            None,
            DBusCallFlags::NO_AUTO_START,
            500,
            None::<&webkit2gtk::gio::Cancellable>,
        )
        .ok()
        .and_then(|reply| reply.try_child_value(0))
        .and_then(|inner| inner.get::<bool>())
        .unwrap_or(false)
}

/// True when a StatusNotifier host can actually render an indicator: a
/// watcher owns its well-known name AND it currently reports a registered
/// host (GNOME's AppIndicator extension provides both; a half-installed
/// stack may expose a watcher without ever registering a host).
pub fn status_notifier_host_ready() -> bool {
    if !status_notifier_watcher_owned() {
        return false;
    }
    let Ok(connection) =
        webkit2gtk::gio::bus_get_sync(BusType::Session, None::<&webkit2gtk::gio::Cancellable>)
    else {
        return false;
    };
    connection
        .call_sync(
            Some("org.kde.StatusNotifierWatcher"),
            "/StatusNotifierWatcher",
            "org.freedesktop.DBus.Properties",
            "Get",
            Some(
                &(
                    "org.kde.StatusNotifierWatcher",
                    "IsStatusNotifierHostRegistered",
                )
                    .to_variant(),
            ),
            // Properties.Get answers (v); the boxed bool is unpacked by
            // parse_host_registered below instead of pinning the reply type.
            None,
            DBusCallFlags::NO_AUTO_START,
            500,
            None::<&webkit2gtk::gio::Cancellable>,
        )
        .ok()
        .map(|reply| parse_host_registered(&reply))
        .unwrap_or(false)
}

// Properties.Get replies with `(v)` — the tuple's only child is itself a
// DVARIANT boxing the property value. `g_variant_get_child_value` does NOT
// unbox, and glib-rs' `Variant::get::<bool>()` accepts type 'b' only, so the
// boxed value must be unwrapped via `as_variant()` first or every read fails
// and this probe would hardwire `false` even on desktops with a working tray.
// The unbox is guarded by the child's own type string: `as_variant()` outside
// its `'v'` contract is unspecified, so it is only ever invoked on a 'v'; any
// other well-typed child falls through to the plain read below, and anything
// that is not a bool anywhere in the chain reads as absent (`false`).
fn parse_host_registered(reply: &webkit2gtk::glib::Variant) -> bool {
    let Some(child) = reply.try_child_value(0) else {
        return false;
    };
    let inner = if child.type_().as_str() == "v" {
        child.as_variant()
    } else {
        Some(child)
    };
    inner.and_then(|value| value.get::<bool>()).unwrap_or(false)
}

/// Boot record for the tray-probe outcome, mirrored to stderr like every
/// other boot fact. Called from setup_desktop once the tray has been built.
pub fn record_tray_probe(built: bool, host_ready: bool) {
    record(
        "boot.tray_probe",
        &[("built", flag(built)), ("host_ready", flag(host_ready))],
    );
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
        record(
            "boot.crash_recovery",
            &[("installed", flag(false)), ("why", word("no_main_window"))],
        );
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
        record(
            "boot.crash_recovery",
            &[
                ("installed", flag(false)),
                ("why", word("with_webview_failed")),
            ],
        );
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

    #[test]
    fn packaged_webkit_probes_target_the_staged_appimage_layout() {
        // Must stay byte-identical to src-tauri/tauri.linux.conf.json's bundle
        // files and scripts/check-linux-appimage.sh's validated locations: the
        // WebKit processes sit directly in bin/studyvis-webkit-runtime and
        // bwrap in bin/. A drift here makes boot.packaged_webkit_runtime lie.
        let probes = packaged_webkit_probes(std::path::Path::new("/mnt/usr"));
        assert_eq!(
            probes.0,
            std::path::PathBuf::from("/mnt/usr/bin/studyvis-webkit-runtime")
        );
        assert_eq!(
            probes.1,
            std::path::PathBuf::from("/mnt/usr/bin/studyvis-webkit-runtime/WebKitWebProcess")
        );
        assert_eq!(probes.2, std::path::PathBuf::from("/mnt/usr/bin/bwrap"));
    }

    #[test]
    fn host_registered_parses_the_boxed_bool_out_of_a_properties_get_reply() {
        use webkit2gtk::glib::{ToVariant, Variant};
        // org.freedesktop.DBus.Properties.Get answers `(v)`: a one-child tuple
        // holding the property value boxed as a DVARIANT. `tuple_from_iter`
        // takes children as-is (a 1-tuple's ToVariant would re-box a Variant
        // child into '(vv)'), so this is the honest wire shape. The child is
        // NOT auto-unboxed on read, so the parser must call as_variant()
        // before reading — reading the tuple child as 'b' directly fails.
        let boxed = Variant::from_variant(&true.to_variant());
        let reply = Variant::tuple_from_iter([boxed]);
        assert_eq!(reply.type_().as_str(), "(v)");
        assert!(parse_host_registered(&reply));

        let boxed = Variant::from_variant(&false.to_variant());
        let reply = Variant::tuple_from_iter([boxed]);
        assert!(!parse_host_registered(&reply));
    }

    #[test]
    fn host_registered_replies_degrade_without_panicking() {
        use webkit2gtk::glib::{ToVariant, Variant};
        // A bare bool child ('(b)') skips the unbox guard and reads directly —
        // same property value without the box, so true stays true.
        let unboxed = Variant::tuple_from_iter([true.to_variant()]);
        assert_eq!(unboxed.type_().as_str(), "(b)");
        assert!(parse_host_registered(&unboxed));
        // A boxed string ('(vs)') boxes fine but is not a bool: false.
        let wrong_inner = Variant::tuple_from_iter([Variant::from_variant(&"x".to_variant())]);
        assert_eq!(wrong_inner.type_().as_str(), "(v)");
        assert!(!parse_host_registered(&wrong_inner));
        // An empty tuple (malformed reply) likewise reads false.
        let empty = Variant::tuple_from_iter([] as [Variant; 0]);
        assert_eq!(empty.type_().as_str(), "()");
        assert!(!parse_host_registered(&empty));
    }
}
