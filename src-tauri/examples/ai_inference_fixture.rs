//! Disposable native command host for the scheduled CPU inference canary.

#[path = "../src/commands/applog.rs"]
pub mod applog;
#[path = "../src/commands/compute_device.rs"]
pub mod compute_device;
#[path = "../src/commands/engine.rs"]
pub mod engine;
#[path = "../src/commands/identity.rs"]
pub mod identity;
#[path = "../src/commands/models.rs"]
pub mod models;
#[path = "../src/commands/session_journal.rs"]
pub mod session_journal;
#[path = "../src/commands/sessions.rs"]
pub mod sessions;
#[path = "../src/commands/sidecar.rs"]
pub mod sidecar;
pub use studyvis_lib::{crypto, db};

pub mod commands {
    pub use crate::{applog, compute_device, engine, identity, models, session_journal, sidecar};
}

use serde_json::{json, Value};
use std::io::{BufRead, Write};
use std::path::PathBuf;
use tauri::Manager;

fn output(value: Value) {
    let mut stdout = std::io::stdout().lock();
    serde_json::to_writer(&mut stdout, &value).expect("fixture JSON");
    writeln!(stdout).expect("fixture stdout");
    stdout.flush().expect("fixture flush");
}

fn fixture_root() -> PathBuf {
    let root = PathBuf::from(std::env::var("STUDYVIS_CI_AI_ROOT").expect("isolated fixture root"));
    assert!(root.is_absolute() && root.is_dir());
    for (variable, relative) in [
        ("XDG_DATA_HOME", "data"),
        ("XDG_CONFIG_HOME", "config"),
        ("XDG_CACHE_HOME", "cache"),
    ] {
        assert_eq!(
            PathBuf::from(std::env::var(variable).expect(variable)),
            root.join(relative)
        );
    }
    root
}

fn string(args: &Value, name: &str) -> Result<String, String> {
    args[name]
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| format!("missing {name}"))
}

async fn command(app: &tauri::AppHandle, request: &Value) -> Result<Value, String> {
    let args = &request["args"];
    match request["cmd"].as_str().unwrap_or_default() {
        "sidecar_start" => serde_json::to_value(
            sidecar::sidecar_start(
                app.clone(),
                app.state(),
                app.state(),
                app.state(),
                string(args, "modelPath")?,
                Some(string(args, "mmprojPath")?),
                args["ctxSize"]
                    .as_u64()
                    .and_then(|v| u32::try_from(v).ok())
                    .ok_or("missing ctxSize")?,
                false,
            )
            .await?,
        )
        .map_err(|e| e.to_string()),
        "sidecar_status" => serde_json::to_value(sidecar::sidecar_status(app.state()).await?)
            .map_err(|e| e.to_string()),
        "sidecar_stop" => {
            sidecar::sidecar_stop(app.state()).await?;
            Ok(Value::Null)
        }
        "model_paths" => {
            serde_json::to_value(models::model_paths(app.clone(), string(args, "modelId")?)?)
                .map_err(|e| e.to_string())
        }
        "session_timeline_save" => {
            sessions::session_timeline_save(
                app.state(),
                string(args, "sessionId")?,
                args["generatedAt"].as_i64().ok_or("missing generatedAt")?,
                args["coveredUntil"].as_i64(),
                args["modelId"].as_str().map(str::to_owned),
                string(args, "source")?,
                string(args, "entries")?,
                args["truncated"].as_bool().ok_or("missing truncated")?,
            )?;
            Ok(Value::Null)
        }
        "session_timeline_get" => serde_json::to_value(sessions::session_timeline_get(
            app.state(),
            string(args, "sessionId")?,
        )?)
        .map_err(|e| e.to_string()),
        "app_log_append" => {
            let lines = serde_json::from_value(args["lines"].clone()).map_err(|e| e.to_string())?;
            applog::app_log_append(app.clone(), lines)?;
            Ok(Value::Null)
        }
        _ => Err("unsupported canary command".to_owned()),
    }
}

fn main() {
    let root = fixture_root();
    let mut context = tauri::generate_context!();
    context.config_mut().identifier = "local.studyvis.ci.ai-inference".to_owned();
    context.config_mut().app.windows.clear();
    let (sender, mut requests) = tokio::sync::mpsc::unbounded_channel::<Value>();
    std::thread::spawn(move || {
        for line in std::io::stdin().lock().lines() {
            let Ok(line) = line else { break };
            let Ok(request) = serde_json::from_str(&line) else {
                break;
            };
            if sender.send(request).is_err() {
                break;
            }
        }
    });
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .manage(sidecar::SidecarState::new())
        .manage(engine::EngineState::new())
        .manage(models::ModelOperationState::new())
        .setup(move |app| {
            let data = app.path().app_data_dir()?;
            assert!(data.starts_with(root.join("data")));
            std::fs::create_dir_all(&data)?;
            std::fs::write(data.join("ai-hardware.json"), r#"{"selection":"cpu"}"#)?;
            let initialized =
                db::init(app.handle()).map_err(|_| "disposable database initialization failed")?;
            app.manage(initialized.pool);
            sessions::sessions_insert(
                app.state(),
                "cb".repeat(32),
                1_700_000_000_000,
                1_700_000_180_000,
                Some(3),
                Some(180_000),
                None,
                Some("{}".to_owned()),
                Some("Synthetic algebra study".to_owned()),
                Some(100),
                Some(1.0),
                Some(1_700_000_180_000),
                Some(3),
                Some(0),
                Some(1),
                Some("ab".repeat(32)),
                Some("Synthetic CI canary".to_owned()),
                None,
            )
            .map_err(std::io::Error::other)?;
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                output(json!({"ready": true, "dataDir": data}));
                while let Some(request) = requests.recv().await {
                    let id = request["id"].clone();
                    match command(&handle, &request).await {
                        Ok(result) => output(json!({"id": id, "result": result})),
                        Err(error) => output(json!({"id": id, "error": error})),
                    }
                }
                let _ = sidecar::sidecar_stop(handle.state()).await;
                handle.exit(0);
            });
            Ok(())
        })
        .build(context)
        .expect("native canary host")
        .run(|app, event| {
            if matches!(
                event,
                tauri::RunEvent::Exit | tauri::RunEvent::ExitRequested { .. }
            ) {
                sidecar::SidecarState::kill_blocking(app);
            }
        });
}
