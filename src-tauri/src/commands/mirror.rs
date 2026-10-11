use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
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
}

impl MirrorState {
    fn begin(&self, request_id: String) -> (u64, Vec<MirrorServer>) {
        let mut slot = self.slot.lock().unwrap();
        slot.revision += 1;
        slot.request_id = Some(request_id);
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
    session_id: String,
    request_id: String,
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
    let (revision, previous) = state.begin(request_id.clone());
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
        if SessionActiveFlag::is_active(&app)
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
    use super::MirrorState;

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
