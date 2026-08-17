//! WebKitGTK user-media permission bridge.
//!
//! WebKitGTK denies `WebKitUserMediaPermissionRequest` by default when the
//! embedding client does not handle `WebKitWebView::permission-request`.
//! StudyVis's bundled WebKitGTK enables the compiled WebRTC surface, and the
//! pinned wry patch supplies its runtime preference during WebView creation.
//! This module applies the separate top-level-URI capture policy once Tauri
//! exposes the native view. WebKitGTK 2.52 does not expose the request's two
//! `SecurityOrigin` values through this wrapper, so the handler cannot claim
//! per-request-origin authentication.

use tauri::{Manager, Runtime};
use webkit2gtk::glib::prelude::ObjectExt;
use webkit2gtk::{PermissionRequestExt, UserMediaPermissionRequest, WebViewExt};

/// Installs the permission bridge on StudyVis's main webview.
///
/// User-media requests are accepted only while the main webview's current
/// top-level URI is StudyVis-owned. The self-only frame CSP completes that
/// boundary; if the top-level view does navigate elsewhere, the same request
/// class is explicitly denied there. Other WebKit permission classes
/// (geolocation, notifications, clipboard, and so on) retain WebKit's default
/// behavior.
pub fn install<R: Runtime>(app: &tauri::AppHandle<R>) {
    let Some(window) = app.get_webview_window("main") else {
        eprintln!("[linux-media] no main window; user media stays denied");
        return;
    };

    if let Err(error) = window.with_webview(|platform_webview| {
        platform_webview
            .inner()
            .connect_permission_request(|webview, request| {
                let trusted_top_level_uri = webview
                    .uri()
                    .is_some_and(|uri| is_trusted_app_uri(uri.as_str()));
                if !request.is::<UserMediaPermissionRequest>() {
                    return false;
                }

                // Handle every user-media request ourselves. Returning false
                // for an untrusted page currently falls through to WebKit's
                // default denial, but an explicit deny keeps that boundary
                // intact if another signal handler is added later.
                if trusted_top_level_uri {
                    request.allow();
                } else {
                    request.deny();
                }
                true
            });
    }) {
        eprintln!("[linux-media] with_webview failed; user media stays denied: {error}");
    }
}

fn is_trusted_app_uri(uri: &str) -> bool {
    crate::app_navigation::is_trusted_app_uri(uri)
}

#[cfg(test)]
mod tests {
    use super::is_trusted_app_uri;

    #[test]
    fn accepts_only_the_bundled_tauri_origin_in_release_semantics() {
        assert!(is_trusted_app_uri("tauri://localhost"));
        assert!(is_trusted_app_uri("tauri://localhost/index.html"));
        assert!(!is_trusted_app_uri("tauri://attacker.invalid/"));
        assert!(!is_trusted_app_uri("https://tauri.localhost/"));
        assert!(!is_trusted_app_uri("https://example.com/"));
    }

    #[test]
    fn debug_build_accepts_only_the_configured_loopback_origin() {
        assert_eq!(
            is_trusted_app_uri("http://localhost:1420/"),
            cfg!(debug_assertions)
        );
        assert_eq!(
            is_trusted_app_uri("http://127.0.0.1:1420/"),
            cfg!(debug_assertions)
        );
        assert!(!is_trusted_app_uri("http://localhost:9999/"));
        assert!(!is_trusted_app_uri("http://localhost.evil.test:1420/"));
        assert!(!is_trusted_app_uri("http://localhost:1420@evil.test/"));
        assert!(!is_trusted_app_uri("http://localhost/"));
        assert!(!is_trusted_app_uri("not a URL"));
    }
}
