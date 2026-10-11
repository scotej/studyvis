use serde_json::{json, Value};
use std::io::{BufRead, Write};
use std::net::Ipv4Addr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use studyvis_lib::mirror::{
    allowed_asset_path, MirrorAsset, MirrorEvent, MirrorServer, MirrorServerOptions,
};

fn output(value: Value) {
    let mut stdout = std::io::stdout().lock();
    if serde_json::to_writer(&mut stdout, &value).is_ok() {
        let _ = writeln!(stdout);
        let _ = stdout.flush();
    }
}

fn mime_type(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or_default() {
        "html" => "text/html; charset=utf-8",
        "js" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "webmanifest" | "json" => "application/manifest+json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        _ => "application/octet-stream",
    }
}

#[tokio::main]
async fn main() {
    let mut args = std::env::args().skip(1);
    let certificate_dir = PathBuf::from(args.next().expect("certificate directory required"));
    let assets_dir = PathBuf::from(args.next().expect("built assets directory required"));
    let (sender, mut requests) = tokio::sync::mpsc::unbounded_channel();
    std::thread::spawn(move || {
        for line in std::io::stdin().lock().lines() {
            let Ok(line) = line else { break };
            let Ok(request) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if sender.send(request).is_err() {
                break;
            }
        }
    });
    let mut server: Option<MirrorServer> = None;
    let mut owner: Option<String> = None;
    while let Some(request) = requests.recv().await {
        let id = request["id"].clone();
        let args = &request["args"];
        let result: Result<Value, String> = match request["cmd"].as_str().unwrap_or_default() {
            "mirror_start" => {
                owner = args["requestId"].as_str().map(str::to_owned);
                if let Some(previous) = server.take() {
                    previous.shutdown().await;
                }
                let assets = assets_dir.clone();
                let options = MirrorServerOptions {
                    certificate_dir: certificate_dir.clone(),
                    addresses: vec![Ipv4Addr::LOCALHOST],
                    asset: Arc::new(move |path| {
                        // The production router passes a normalized asset name.
                        let relative = allowed_asset_path(&format!("/{path}"))?;
                        let bytes = std::fs::read(assets.join(&relative)).ok()?;
                        Some(MirrorAsset {
                            bytes,
                            mime_type: mime_type(&relative).to_owned(),
                        })
                    }),
                    on_event: Arc::new(|event| match event {
                        MirrorEvent::Client {
                            client_id,
                            connected,
                        } => output(json!({
                            "event": "mirror:client",
                            "payload": { "clientId": client_id, "connected": connected }
                        })),
                        MirrorEvent::Message { client_id, data } => output(json!({
                            "event": "mirror:message",
                            "payload": { "clientId": client_id, "data": data }
                        })),
                    }),
                    lease: Duration::from_secs(4 * 60 * 60),
                };
                match MirrorServer::start(options).await {
                    Ok(listener) => {
                        let config = serde_json::to_value(listener.config()).unwrap();
                        server = Some(listener);
                        Ok(config)
                    }
                    Err(error) => Err(error),
                }
            }
            "mirror_stop" => {
                // No request id is reserved for fixture teardown only.
                let requested = args["requestId"].as_str();
                if requested.is_none() || requested == owner.as_deref() {
                    owner = None;
                    if let Some(previous) = server.take() {
                        previous.shutdown().await;
                    }
                }
                Ok(Value::Null)
            }
            "mirror_send" => match server.as_ref() {
                Some(listener) => listener
                    .send(
                        args["clientId"].as_str().unwrap_or_default(),
                        args["data"].as_str().unwrap_or_default().to_owned(),
                    )
                    .await
                    .map(|()| Value::Null),
                None => Err("Mirroring is stopped".to_owned()),
            },
            _ => Err("Unsupported fixture command".to_owned()),
        };
        match result {
            Ok(value) => output(json!({ "id": id, "result": value })),
            Err(error) => output(json!({ "id": id, "error": error })),
        }
    }
    if let Some(listener) = server {
        listener.shutdown().await;
    }
}
