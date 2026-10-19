use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Runtime};

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
    retiring: Vec<MirrorServer>,
    request_id: Option<String>,
    revision: u64,
    scope: MirrorScope,
}

#[derive(Clone, Copy, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MirrorScope {
    #[default]
    Session,
    App,
}

impl MirrorScope {
    fn permits_start(self, session_active: bool, session_id: Option<&str>) -> bool {
        self == Self::App || (session_active && session_id.is_some_and(valid_session_id))
    }
}

fn valid_session_id(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit())
}

impl MirrorState {
    fn begin(&self, request_id: String, scope: MirrorScope) -> (u64, Vec<MirrorServer>) {
        let mut slot = self.slot.lock().unwrap();
        slot.revision += 1;
        slot.request_id = Some(request_id);
        slot.scope = scope;
        let mut previous = std::mem::take(&mut slot.retiring);
        if let Some(server) = slot.server.take() {
            server.stop();
            previous.push(server);
        }
        (slot.revision, previous)
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
        slot.server.take().inspect(MirrorServer::stop)
    }

    pub fn stop(&self) {
        let mut slot = self.slot.lock().unwrap();
        slot.revision += 1;
        slot.request_id = None;
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

    fn end_session(&self) -> Option<String> {
        let slot = self.slot.lock().unwrap();
        if slot.scope == MirrorScope::App {
            slot.request_id.clone()
        } else {
            drop(slot);
            self.stop();
            None
        }
    }

    pub fn end_session_for_app<R: Runtime>(app: &AppHandle<R>) {
        if let Some(state) = app.try_state::<Self>() {
            if let Some(request_id) = state.end_session() {
                let _ = app.emit_to(
                    "main",
                    "mirror:session-ended",
                    SessionEndedEvent { request_id },
                );
            }
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionEndedEvent {
    request_id: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ClientEvent {
    client_id: String,
    connected: bool,
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
    session_id: Option<String>,
    request_id: String,
    scope: Option<MirrorScope>,
) -> Result<MirrorConfig, String> {
    let scope = scope.unwrap_or_default();
    if !scope.permits_start(SessionActiveFlag::is_active(&app), session_id.as_deref()) {
        return Err("start a study session before enabling browser access".into());
    }
    if session_id
        .as_deref()
        .is_some_and(|id| !valid_session_id(id))
    {
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
    let (revision, previous) = state.begin(request_id.clone(), scope);
    let _starting = state.starting.lock().await;
    for previous in previous {
        previous.shutdown().await;
    }
    if !state.owns(&request_id, revision)
        || !scope.permits_start(SessionActiveFlag::is_active(&app), session_id.as_deref())
    {
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
            } => {
                let _ = event_app.emit_to(
                    "main",
                    "mirror:client",
                    ClientEvent {
                        client_id,
                        connected,
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
        if scope.permits_start(SessionActiveFlag::is_active(&app), session_id.as_deref())
            && slot.revision == revision
            && slot.request_id.as_deref() == Some(&request_id)
        {
            let config = server.config().clone();
            slot.server = Some(server);
            return Ok(config);
        }
    }
    server.shutdown().await;
    Err("browser access was cancelled".into())
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
    use super::{MirrorAsset, MirrorScope, MirrorServer, MirrorServerOptions, MirrorState};
    use std::net::Ipv4Addr;
    use std::sync::Arc;
    use std::time::{Duration, SystemTime};

    #[test]
    fn cancelled_start_cannot_stop_a_newer_request() {
        let state = MirrorState::default();
        let (first, _) = state.begin("first".into(), MirrorScope::Session);
        assert!(state.owns("first", first));
        state.cancel(Some("first"));
        let (second, _) = state.begin("second".into(), MirrorScope::App);
        state.cancel(Some("first"));
        assert!(state.owns("second", second));
        assert!(!state.owns("first", first));
        state.stop();
        assert!(!state.owns("second", second));
    }

    #[test]
    fn session_scope_still_requires_a_real_active_session() {
        let id = "a".repeat(64);
        assert!(!MirrorScope::Session.permits_start(false, Some(&id)));
        assert!(!MirrorScope::Session.permits_start(true, None));
        assert!(!MirrorScope::Session.permits_start(true, Some("invalid")));
        assert!(MirrorScope::Session.permits_start(true, Some(&id)));
        assert!(MirrorScope::App.permits_start(false, None));
        assert!(serde_json::from_str::<MirrorScope>("\"unknown\"").is_err());
    }

    #[test]
    fn session_end_retires_session_scope_but_keeps_explicit_app_scope() {
        let state = MirrorState::default();
        let (session_revision, _) = state.begin("session".into(), MirrorScope::Session);
        assert!(state.end_session().is_none());
        assert!(!state.owns("session", session_revision));
        let (app_revision, _) = state.begin("app".into(), MirrorScope::App);
        assert_eq!(state.end_session().as_deref(), Some("app"));
        assert!(state.owns("app", app_revision));
        state.stop();
        assert!(!state.owns("app", app_revision));
    }

    #[tokio::test]
    async fn actual_tls_listener_only_survives_leave_with_explicit_app_scope() {
        for scope in [MirrorScope::Session, MirrorScope::App] {
            let directory = std::env::temp_dir().join(format!(
                "studyvis-app-scope-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(SystemTime::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            let server = MirrorServer::start(MirrorServerOptions {
                certificate_dir: directory.clone(),
                addresses: vec![Ipv4Addr::LOCALHOST],
                asset: Arc::new(|path| {
                    (path == "mirror.html").then(|| MirrorAsset {
                        bytes: b"companion".to_vec(),
                        mime_type: "text/plain".into(),
                    })
                }),
                on_event: Arc::new(|_| {}),
                lease: Duration::from_secs(60),
            })
            .await
            .unwrap();
            let url = server.config().urls[0].clone();
            let root =
                reqwest::Certificate::from_der(&std::fs::read(directory.join("root.crt")).unwrap())
                    .unwrap();
            let client = reqwest::Client::builder()
                .add_root_certificate(root)
                .no_proxy()
                .build()
                .unwrap();
            let state = MirrorState::default();
            let (revision, _) = state.begin("scope-proof".into(), scope);
            state.slot.lock().unwrap().server = Some(server);
            assert_eq!(client.get(&url).send().await.unwrap().status(), 200);
            state.end_session();
            if scope == MirrorScope::App {
                assert!(state.owns("scope-proof", revision));
                assert_eq!(client.get(&url).send().await.unwrap().status(), 200);
            } else {
                assert!(!state.owns("scope-proof", revision));
                if let Ok(response) = client.get(&url).send().await {
                    assert_eq!(response.status(), 410);
                }
            }
            state.stop();
            if let Ok(response) = client.get(&url).send().await {
                assert_eq!(response.status(), 410);
            }
            let retired = std::mem::take(&mut state.slot.lock().unwrap().retiring);
            for server in retired {
                server.shutdown().await;
            }
            std::fs::remove_dir_all(directory).unwrap();
        }
    }
}
