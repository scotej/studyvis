use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime};

use super::native_log::{self, NativeLevel};
use super::system::SessionActiveFlag;
use crate::mirror::{
    local_addresses, MirrorAsset, MirrorConfig, MirrorEvent, MirrorServer, MirrorServerOptions,
};

#[derive(Default)]
pub struct MirrorState {
    slot: Mutex<MirrorSlot>,
    starting: tokio::sync::Mutex<()>,
}

#[derive(Default)]
struct MirrorSlot {
    server: Option<MirrorServer>,
    // The study session the live server was started for; a restarted desktop
    // page that rejoins it adopts the server instead of rotating the password.
    session_id: Option<String>,
    retiring: Vec<MirrorServer>,
    request_id: Option<String>,
    revision: u64,
}

/// What a start request should do with the slot it found.
enum StartPlan {
    Adopt(MirrorConfig),
    Replace(u64, Vec<MirrorServer>),
}

impl MirrorState {
    fn begin(&self, request_id: String) -> (u64, Vec<MirrorServer>) {
        let mut slot = self.slot.lock().unwrap();
        slot.revision += 1;
        slot.request_id = Some(request_id);
        slot.session_id = None;
        let mut previous = std::mem::take(&mut slot.retiring);
        if let Some(server) = slot.server.take() {
            server.stop();
            previous.push(server);
        }
        (slot.revision, previous)
    }

    fn plan(&self, session_id: &str, request_id: String) -> StartPlan {
        if let Some(config) = self.adopt(session_id, request_id.clone()) {
            return StartPlan::Adopt(config);
        }
        let (revision, previous) = self.begin(request_id);
        StartPlan::Replace(revision, previous)
    }

    /// Transfers a live server for the same session to a new request and asks
    /// its browser to reconnect, keeping the password, cookie and expiry.
    fn adopt(&self, session_id: &str, request_id: String) -> Option<MirrorConfig> {
        let mut slot = self.slot.lock().unwrap();
        if slot.session_id.as_deref() != Some(session_id)
            || !slot.server.as_ref().is_some_and(MirrorServer::is_active)
        {
            return None;
        }
        slot.revision += 1;
        slot.request_id = Some(request_id);
        let server = slot.server.as_ref()?;
        server.reconnect_controller();
        Some(server.config().clone())
    }

    fn resumable(&self, session_id: &str) -> bool {
        let slot = self.slot.lock().unwrap();
        slot.session_id.as_deref() == Some(session_id)
            && slot.server.as_ref().is_some_and(MirrorServer::is_active)
    }

    fn owns(&self, request_id: &str, revision: u64) -> bool {
        let slot = self.slot.lock().unwrap();
        slot.request_id.as_deref() == Some(request_id) && slot.revision == revision
    }

    fn cancel(&self, request_id: Option<&str>) -> Option<MirrorServer> {
        let mut slot = self.slot.lock().unwrap();
        if request_id.is_some() && slot.request_id.as_deref() != request_id {
            return None;
        }
        slot.revision += 1;
        slot.request_id = None;
        slot.session_id = None;
        slot.server.take().inspect(MirrorServer::stop)
    }

    pub fn stop(&self) {
        let mut slot = self.slot.lock().unwrap();
        slot.revision += 1;
        slot.request_id = None;
        slot.session_id = None;
        if let Some(server) = slot.server.take() {
            server.stop();
            slot.retiring.push(server);
        }
    }

    pub fn stop_for_app<R: Runtime>(app: &AppHandle<R>) {
        if let Some(state) = app.try_state::<Self>() {
            state.stop();
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ClientEvent {
    client_id: String,
    connected: bool,
    address: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DiagnosticEvent {
    address: String,
    problem: &'static str,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MessageEvent {
    client_id: String,
    data: String,
}

#[tauri::command]
pub async fn mirror_start<R: Runtime>(
    app: AppHandle<R>,
    session_id: String,
    request_id: String,
    resume: Option<bool>,
) -> Result<MirrorConfig, String> {
    if !SessionActiveFlag::is_active(&app) {
        return Err("start a study session before enabling browser access".into());
    }
    if session_id.len() != 64 || !session_id.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("invalid study session".into());
    }
    if request_id.is_empty()
        || request_id.len() > 128
        || !request_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
    {
        return Err("invalid browser access request".into());
    }
    let state = app.state::<MirrorState>();
    // Claim ownership before awaiting the previous start. An older request's
    // eventual cleanup must never stop its replacement.
    // An automatic resume must never mint a new password the paired browser
    // doesn't have; it adopts the live server or fails without touching it.
    if resume == Some(true) {
        return match state.adopt(&session_id, request_id) {
            Some(config) => {
                native_log::record(NativeLevel::Info, "mirror.server", "server.adopted", &[]);
                Ok(config)
            }
            None => Err("the browser companion is no longer running".into()),
        };
    }
    let (revision, previous) = match state.plan(&session_id, request_id.clone()) {
        StartPlan::Adopt(config) => {
            native_log::record(NativeLevel::Info, "mirror.server", "server.adopted", &[]);
            return Ok(config);
        }
        StartPlan::Replace(revision, previous) => (revision, previous),
    };
    let _starting = state.starting.lock().await;
    for previous in previous {
        previous.shutdown().await;
    }
    if !state.owns(&request_id, revision) || !SessionActiveFlag::is_active(&app) {
        return Err("browser access was cancelled".into());
    }
    let asset_app = app.clone();
    let event_app = app.clone();
    let options = MirrorServerOptions {
        certificate_dir: crate::db::data_dir(&app)?.join("browser-certificate"),
        addresses: local_addresses()?,
        asset: Arc::new(move |path| {
            asset_app
                .asset_resolver()
                .get(path.to_string())
                .map(|asset| MirrorAsset {
                    bytes: asset.bytes,
                    mime_type: asset.mime_type,
                })
        }),
        on_event: Arc::new(move |event| match event {
            MirrorEvent::Client {
                client_id,
                connected,
                address,
            } => {
                let _ = event_app.emit_to(
                    "main",
                    "mirror:client",
                    ClientEvent {
                        client_id,
                        connected,
                        address: address.map(|ip| ip.to_string()),
                    },
                );
            }
            MirrorEvent::Diagnostic { address, problem } => {
                let _ = event_app.emit_to(
                    "main",
                    "mirror:diagnostic",
                    DiagnosticEvent {
                        address: address.to_string(),
                        problem: problem.as_str(),
                    },
                );
            }
            MirrorEvent::Message { client_id, data } => {
                let _ =
                    event_app.emit_to("main", "mirror:message", MessageEvent { client_id, data });
            }
        }),
        lease: Duration::from_secs(12 * 60 * 60),
    };
    let server = MirrorServer::start(options).await?;
    {
        let mut slot = state.slot.lock().unwrap();
        if SessionActiveFlag::is_active(&app)
            && slot.revision == revision
            && slot.request_id.as_deref() == Some(&request_id)
        {
            let config = server.config().clone();
            slot.server = Some(server);
            slot.session_id = Some(session_id);
            return Ok(config);
        }
    }
    server.shutdown().await;
    Err("browser access was cancelled".into())
}

#[tauri::command]
pub fn mirror_resumable<R: Runtime>(app: AppHandle<R>, session_id: String) -> bool {
    app.state::<MirrorState>().resumable(&session_id)
}

#[tauri::command]
pub async fn mirror_stop<R: Runtime>(app: AppHandle<R>, request_id: String) -> Result<(), String> {
    let state = app.state::<MirrorState>();
    let server = state.cancel(Some(&request_id));
    let _starting = state.starting.lock().await;
    if let Some(server) = server {
        server.shutdown().await;
    }
    Ok(())
}

#[tauri::command]
pub async fn mirror_send<R: Runtime>(
    app: AppHandle<R>,
    client_id: String,
    data: String,
) -> Result<(), String> {
    let state = app.state::<MirrorState>();
    let sender = {
        let slot = state.slot.lock().unwrap();
        slot.server
            .as_ref()
            .ok_or("browser access is disabled")?
            .sender(&client_id)?
    };
    sender.send(data).await
}

#[cfg(test)]
mod tests {
    use super::{MirrorState, StartPlan};
    use crate::mirror::{MirrorServer, MirrorServerOptions};
    use std::net::Ipv4Addr;
    use std::sync::Arc;
    use std::time::Duration;

    async fn server(directory: &std::path::Path) -> MirrorServer {
        MirrorServer::start(MirrorServerOptions {
            certificate_dir: directory.to_path_buf(),
            addresses: vec![Ipv4Addr::LOCALHOST],
            asset: Arc::new(|_| None),
            on_event: Arc::new(|_| {}),
            lease: Duration::from_secs(60),
        })
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn restarted_page_adopts_the_live_server_for_its_session_only() {
        let directory =
            std::env::temp_dir().join(format!("studyvis-mirror-adopt-{}", std::process::id()));
        let state = MirrorState::default();
        let (revision, _) = state.begin("first".into());
        let started = server(&directory).await;
        let config = started.config().clone();
        {
            let mut slot = state.slot.lock().unwrap();
            assert_eq!(slot.revision, revision);
            slot.server = Some(started);
            slot.session_id = Some("a".repeat(64));
        }
        assert!(state.resumable(&"a".repeat(64)));
        assert!(!state.resumable(&"b".repeat(64)));
        let StartPlan::Adopt(adopted) = state.plan(&"a".repeat(64), "second".into()) else {
            panic!("the same session must adopt its live server");
        };
        assert_eq!(adopted.password, config.password);
        assert_eq!(adopted.generation, config.generation);
        assert_eq!(adopted.expires_at, config.expires_at);
        // The page that started it can no longer stop its successor.
        assert!(state.cancel(Some("first")).is_none());
        assert!(state.resumable(&"a".repeat(64)));
        let StartPlan::Replace(_, previous) = state.plan(&"b".repeat(64), "third".into()) else {
            panic!("a different session must replace the server");
        };
        assert_eq!(previous.len(), 1);
        assert!(!state.resumable(&"a".repeat(64)));
        for server in previous {
            server.shutdown().await;
        }
        state.stop();
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn cancelled_start_cannot_stop_a_newer_request() {
        let state = MirrorState::default();
        let (first, _) = state.begin("first".into());
        assert!(state.owns("first", first));
        state.cancel(Some("first"));
        let (second, _) = state.begin("second".into());
        state.cancel(Some("first"));
        assert!(state.owns("second", second));
        assert!(!state.owns("first", first));
        state.stop();
        assert!(!state.owns("second", second));
    }
}
