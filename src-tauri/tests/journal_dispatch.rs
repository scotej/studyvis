//! Real command dispatch with a stopped async executor, without a user profile.

#[path = "../src/commands/worker.rs"]
mod worker;
use worker::blocking;

#[allow(dead_code)]
#[path = "../src/commands/session_journal.rs"]
pub(crate) mod session_journal;
#[allow(dead_code)]
#[path = "../src/commands/sessions.rs"]
mod sessions;

mod commands {
    pub(crate) use super::session_journal;
}

// Only the data-directory resolver is replaced; the IPC, commands, SQLite
// cascade, filesystem operations and blocking-worker boundary are production.
mod db {
    pub use studyvis_lib::db::{audit_events, migrations, session_timelines, sessions, DbPool};
    use tauri::{AppHandle, Manager, Runtime};

    pub fn data_dir<R: Runtime>(app: &AppHandle<R>) -> Result<std::path::PathBuf, String> {
        Ok(app.state::<super::JournalRoot>().0.clone())
    }
}

use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::ipc::{CallbackFn, Invoke, InvokeBody, InvokeResponse};
use tauri::test::MockRuntime;
use tauri::{Manager, WebviewWindow};
use tokio::sync::oneshot;

struct JournalRoot(PathBuf);

fn fixture(
    root: &Path,
    receipt_claim: bool,
) -> (tauri::App<MockRuntime>, WebviewWindow<MockRuntime>) {
    let mut conn = rusqlite::Connection::open_in_memory().unwrap();
    db::migrations::run_migrations(&mut conn).unwrap();
    let generated: fn(Invoke<MockRuntime>) -> bool = tauri::generate_handler![
        session_journal::session_journal_append,
        session_journal::session_journal_read,
        sessions::sessions_delete,
        sessions::sessions_clear_all,
    ];
    let builder = tauri::test::mock_builder()
        .manage(JournalRoot(root.to_owned()))
        .manage(db::DbPool(Arc::new(Mutex::new(conn))));
    let mut context = tauri::generate_context!();
    context.config_mut().app.windows.clear();
    let app = if receipt_claim {
        builder
            .invoke_handler(session_journal::with_append_receipts(generated))
            .build(context)
    } else {
        // Negative control: the exact pre-fix generated async command path.
        builder.invoke_handler(generated).build(context)
    }
    .unwrap();
    let window = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    (app, window)
}

fn dispatch(
    window: &WebviewWindow<MockRuntime>,
    command: &str,
    body: InvokeBody,
) -> oneshot::Receiver<InvokeResponse> {
    let (sender, receiver) = oneshot::channel();
    let webview: &tauri::Webview<MockRuntime> = window.as_ref();
    webview.clone().on_message(
        tauri::webview::InvokeRequest {
            cmd: command.to_owned(),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: if cfg!(windows) {
                "http://tauri.localhost"
            } else {
                "tauri://localhost"
            }
            .parse()
            .unwrap(),
            body,
            headers: Default::default(),
            invoke_key: tauri::test::INVOKE_KEY.to_owned(),
        },
        Box::new(move |_, _, response, _, _| {
            sender.send(response).unwrap();
        }),
    );
    receiver
}

fn finish(
    executor: &tokio::runtime::Runtime,
    response: oneshot::Receiver<InvokeResponse>,
) -> Result<Value, Value> {
    let response = executor.block_on(async {
        tokio::time::timeout(Duration::from_secs(5), response)
            .await
            .unwrap()
            .unwrap()
    });
    match response {
        InvokeResponse::Ok(body) => Ok(body.deserialize().unwrap()),
        InvokeResponse::Err(error) => Err(error.0),
    }
}

#[test]
fn receipt_claim_precedes_reordered_async_dispatch_and_preserves_the_wire_contract() {
    let _serial = session_journal::TEST_LOCK.lock().unwrap();
    let root = std::env::temp_dir().join(format!(
        "studyvis-journal-dispatch-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir_all(&root).unwrap();
    // This executor cannot first-poll an IPC response until finish() drives it.
    let executor = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    tauri::async_runtime::set(executor.handle().clone());
    let delete_driver = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();

    for receipt_claim in [false, true] {
        for clear_all in [false, true] {
            let dir = root.join(format!("receipt-{receipt_claim}-clear-{clear_all}"));
            fs::create_dir_all(dir.join("session-journals")).unwrap();
            let (app, window) = fixture(&dir, receipt_claim);
            let id = "ab".repeat(32);
            let path = dir.join("session-journals").join(format!("{id}.ndjson"));
            app.state::<db::DbPool>()
                .0
                .lock()
                .unwrap()
                .execute(
                    "INSERT INTO sessions (id, started_at, ended_at) VALUES (?1, 1, 2)",
                    [&id],
                )
                .unwrap();
            fs::write(&path, "existing evidence\n").unwrap();
            let mut pending = dispatch(
                &window,
                "session_journal_append",
                json!({"sessionId": id, "lines": ["queued before delete"]}).into(),
            );
            assert!(matches!(
                pending.try_recv(),
                Err(oneshot::error::TryRecvError::Empty)
            ));
            // The real deletion command runs to its successful acknowledgement
            // while the earlier append is received but still unpolled.
            delete_driver
                .block_on(async {
                    if clear_all {
                        sessions::sessions_clear_all(app.handle().clone(), app.state()).await
                    } else {
                        sessions::sessions_delete(app.handle().clone(), app.state(), id.clone())
                            .await
                    }
                })
                .unwrap();
            assert!(!path.exists());
            assert!(
                db::sessions::get(&app.state::<db::DbPool>().0.lock().unwrap(), &id)
                    .unwrap()
                    .is_none()
            );
            assert!(matches!(
                pending.try_recv(),
                Err(oneshot::error::TryRecvError::Empty)
            ));
            assert_eq!(finish(&executor, pending), Ok(Value::Null));
            assert_eq!(path.exists(), !receipt_claim,
                "the pre-fix dispatcher must reproduce resurrection, and the receipt claim must prevent it");
            println!(
                "receipt_claim={receipt_claim} clear_all={clear_all} resurrected={}",
                path.exists()
            );
            if path.exists() {
                fs::remove_file(&path).unwrap();
            }

            let fresh = dispatch(
                &window,
                "session_journal_append",
                json!({"sessionId": id, "lines": ["fresh active observation"]}).into(),
            );
            assert_eq!(finish(&executor, fresh), Ok(Value::Null));
            assert_eq!(
                fs::read_to_string(&path).unwrap(),
                "fresh active observation\n"
            );
            assert!(
                db::sessions::get(&app.state::<db::DbPool>().0.lock().unwrap(), &id)
                    .unwrap()
                    .is_none()
            );
            let read = dispatch(
                &window,
                "session_journal_read",
                json!({"sessionId": id}).into(),
            );
            assert_eq!(
                finish(&executor, read),
                Ok(json!({"lines": ["fresh active observation"], "truncated": false}))
            );
        }
    }

    let (legacy, legacy_window) = fixture(&root.join("legacy-errors"), false);
    let (fixed, fixed_window) = fixture(&root.join("fixed-errors"), true);
    for body in [
        json!({"sessionId": "ab"}).into(),
        json!({"sessionId": 3, "lines": []}).into(),
        json!({"sessionId": "ab", "lines": "wrong type"}).into(),
        json!({"sessionId": "../escape", "lines": ["refused"]}).into(),
        json!({"sessionId": "ab", "lines": ["invalid\nline"]}).into(),
        InvokeBody::Raw(vec![1, 2, 3]),
    ] {
        let before = finish(
            &executor,
            dispatch(&legacy_window, "session_journal_append", body.clone()),
        );
        let after = finish(
            &executor,
            dispatch(&fixed_window, "session_journal_append", body),
        );
        assert!(before.is_err());
        assert_eq!(
            after, before,
            "receipt routing must preserve argument and operation errors"
        );
    }
    let legacy_dialog = tauri::WebviewWindowBuilder::new(&legacy, "ai-dialog", Default::default())
        .build()
        .unwrap();
    let fixed_dialog = tauri::WebviewWindowBuilder::new(&fixed, "ai-dialog", Default::default())
        .build()
        .unwrap();
    let refused_body = json!({"sessionId": "ff".repeat(32), "lines": ["must be denied"]});
    let denied_before = finish(
        &executor,
        dispatch(
            &legacy_dialog,
            "session_journal_append",
            refused_body.clone().into(),
        ),
    );
    let denied_after = finish(
        &executor,
        dispatch(&fixed_dialog, "session_journal_append", refused_body.into()),
    );
    assert!(denied_before
        .as_ref()
        .unwrap_err()
        .as_str()
        .unwrap()
        .contains("not allowed"));
    assert_eq!(
        denied_after, denied_before,
        "ACL must reject before receipt handling"
    );
    assert!(!root
        .join("fixed-errors/session-journals")
        .join(format!("{}.ndjson", "ff".repeat(32)))
        .exists());
    drop((legacy, fixed));
    fs::remove_dir_all(root).unwrap();
}
