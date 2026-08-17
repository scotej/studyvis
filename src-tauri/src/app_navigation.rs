//! Top-level navigation policy shared by every desktop webview.
//!
//! Tauri injects privileged IPC into the app webviews.  External documents
//! therefore belong in the system browser, never inside the main or AI
//! webview.  Keep the accepted origins identical to the Linux user-media
//! bridge so navigation and capture authority cannot drift apart.

use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime, Url,
};

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("trusted-navigation")
        .on_navigation(|_webview, url| is_trusted_app_url(url))
        .build()
}

pub(crate) fn is_trusted_app_uri(uri: &str) -> bool {
    Url::parse(uri).is_ok_and(|url| is_trusted_app_url(&url))
}

fn is_trusted_app_url(url: &Url) -> bool {
    let has_exact_authority =
        url.username().is_empty() && url.password().is_none() && url.port().is_none();

    if has_exact_authority && url.scheme() == "tauri" && url.host_str() == Some("localhost") {
        return true;
    }

    // Wry represents the production Tauri protocol with this HTTP origin on
    // Windows. Other desktop hosts use tauri://localhost.
    if cfg!(target_os = "windows")
        && has_exact_authority
        && url.scheme() == "http"
        && url.host_str() == Some("tauri.localhost")
    {
        return true;
    }

    // The configured development server is fixed at this origin.  Keep the
    // exception out of release builds and compare every authority component
    // so another loopback service cannot inherit Tauri IPC or capture access.
    cfg!(debug_assertions)
        && url.scheme() == "http"
        && matches!(url.host_str(), Some("localhost" | "127.0.0.1"))
        && url.username().is_empty()
        && url.password().is_none()
        && url.port() == Some(1420)
}

#[cfg(test)]
mod tests {
    use super::is_trusted_app_uri;

    #[test]
    fn accepts_only_the_platform_app_origin_in_release_semantics() {
        assert!(is_trusted_app_uri("tauri://localhost"));
        assert!(is_trusted_app_uri("tauri://localhost/index.html"));
        assert_eq!(
            is_trusted_app_uri("http://tauri.localhost/"),
            cfg!(target_os = "windows")
        );
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
