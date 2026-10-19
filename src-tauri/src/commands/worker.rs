// #404: synchronous filesystem, keychain and SQLite work must yield both the
// native event loop and Tokio's async workers. Shared with standalone hosts
// that import command modules by path.
pub(super) async fn blocking<T: Send + 'static>(
    operation: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(|error| format!("blocking command failed: {error}"))?
}
