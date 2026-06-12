use serde::Serialize;
use tauri::State;

use crate::db::{friends, DbPool};

fn lock<'a>(
    state: &'a State<'_, DbPool>,
) -> Result<std::sync::MutexGuard<'a, rusqlite::Connection>, String> {
    state.0.lock().map_err(|e| format!("db poisoned: {e}"))
}

// These commands hold a `std::sync::MutexGuard` for their entire body. Keeping
// them sync (no `async`) means a future caller cannot accidentally `.await`
// across the lock and produce a deadlock. Tauri runs sync commands on its IPC
// thread pool, which matches the rusqlite blocking call shape.
#[tauri::command]
pub fn friends_list(state: State<'_, DbPool>) -> Result<Vec<friends::Friend>, String> {
    let conn = lock(&state)?;
    friends::list(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn friends_add(
    state: State<'_, DbPool>,
    ed_pubkey: String,
    x_pubkey: String,
    name: String,
    ts: i64,
) -> Result<(), String> {
    let conn = lock(&state)?;
    friends::add(&conn, &ed_pubkey, &x_pubkey, &name, ts).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn friends_remove(state: State<'_, DbPool>, ed_pubkey: String) -> Result<(), String> {
    let conn = lock(&state)?;
    friends::remove(&conn, &ed_pubkey).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn friends_update_last_studied(
    state: State<'_, DbPool>,
    ed_pubkey: String,
    ts: i64,
) -> Result<(), String> {
    let conn = lock(&state)?;
    friends::update_last_studied(&conn, &ed_pubkey, ts).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn friends_get_x_pubkey(
    state: State<'_, DbPool>,
    ed_pubkey: String,
) -> Result<Option<String>, String> {
    let conn = lock(&state)?;
    friends::get_x_pubkey(&conn, &ed_pubkey).map_err(|e| e.to_string())
}

// ── D3 friends backup — local file, crypto_box sealed-box to the user's own
// X25519 key. The recipient public key is derived from the keychain private
// key rather than read from identity.json, so export can never encrypt to a
// key that import (which must use the keychain) couldn't open.

const BACKUP_MAGIC: &[u8; 4] = b"SVFB";
const BACKUP_VERSION: u8 = 1;

fn encode_backup(
    my_x_pub: &[u8; crate::crypto::X_KEY_LEN],
    rows: &[friends::Friend],
) -> Result<Vec<u8>, String> {
    use crypto_box::aead::OsRng;
    let json = serde_json::to_vec(rows).map_err(|e| format!("serialize friends: {e}"))?;
    let sealed = crypto_box::PublicKey::from(*my_x_pub)
        .seal(&mut OsRng, &json)
        .map_err(|_| "encrypt failed".to_string())?;
    let mut out = Vec::with_capacity(BACKUP_MAGIC.len() + 1 + sealed.len());
    out.extend_from_slice(BACKUP_MAGIC);
    out.push(BACKUP_VERSION);
    out.extend_from_slice(&sealed);
    Ok(out)
}

fn decode_backup(
    my_x_priv: &[u8; crate::crypto::X_KEY_LEN],
    bytes: &[u8],
) -> Result<Vec<friends::Friend>, String> {
    let body = bytes
        .strip_prefix(BACKUP_MAGIC.as_slice())
        .ok_or("not a StudyVis friends backup file")?;
    let (&version, sealed) = body.split_first().ok_or("truncated backup file")?;
    if version != BACKUP_VERSION {
        return Err(format!("unsupported backup format version {version}"));
    }
    let json = crypto_box::SecretKey::from(*my_x_priv)
        .unseal(sealed)
        .map_err(|_| "decrypt failed: this backup belongs to a different identity".to_string())?;
    serde_json::from_slice(&json).map_err(|e| format!("parse friends: {e}"))
}

#[derive(Serialize)]
pub struct FriendsImportResult {
    pub imported: u32,
    pub updated: u32,
}

fn import_rows(
    conn: &mut rusqlite::Connection,
    rows: &[friends::Friend],
) -> rusqlite::Result<FriendsImportResult> {
    let tx = conn.transaction()?;
    let mut imported = 0u32;
    let mut updated = 0u32;
    for f in rows {
        let exists: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM friends WHERE ed_pubkey_hex = ?1)",
            rusqlite::params![f.ed_pubkey_hex],
            |row| row.get(0),
        )?;
        friends::add(
            &tx,
            &f.ed_pubkey_hex,
            &f.x_pubkey_hex,
            f.display_name.as_deref().unwrap_or(""),
            f.paired_at.unwrap_or(0),
        )?;
        if let Some(ts) = f.last_studied_with {
            friends::update_last_studied(&tx, &f.ed_pubkey_hex, ts)?;
        }
        if exists {
            updated += 1;
        } else {
            imported += 1;
        }
    }
    tx.commit()?;
    Ok(FriendsImportResult { imported, updated })
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
#[tauri::command]
pub fn friends_export(state: State<'_, DbPool>, path: String) -> Result<u32, String> {
    let rows = {
        let conn = lock(&state)?;
        friends::list(&conn).map_err(|e| e.to_string())?
    };
    // No friends → write nothing and report 0, so the frontend's "nothing to
    // back up" toast doesn't contradict a file sitting on disk at the chosen
    // path. (An empty sealed backup is harmless, just pointless.)
    if rows.is_empty() {
        return Ok(0);
    }
    let my_x_priv = crate::commands::identity::load_x_priv()?;
    let my_x_pub = crypto_box::SecretKey::from(my_x_priv).public_key();
    let bytes = encode_backup(my_x_pub.as_bytes(), &rows)?;
    std::fs::write(&path, &bytes).map_err(|e| format!("write {path}: {e}"))?;
    Ok(rows.len() as u32)
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
#[tauri::command]
pub fn friends_import(
    state: State<'_, DbPool>,
    path: String,
) -> Result<FriendsImportResult, String> {
    let bytes = std::fs::read(&path).map_err(|e| format!("read {path}: {e}"))?;
    let my_x_priv = crate::commands::identity::load_x_priv()?;
    let rows = decode_backup(&my_x_priv, &bytes)?;
    let mut conn = lock(&state)?;
    import_rows(&mut conn, &rows).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::migrations;
    use rusqlite::Connection;

    fn fresh() -> Connection {
        let mut conn = Connection::open_in_memory().expect("open in-memory");
        migrations::run_migrations(&mut conn).expect("migrations");
        conn
    }

    fn keypair() -> ([u8; 32], [u8; 32]) {
        use crypto_box::aead::OsRng;
        let sk = crypto_box::SecretKey::generate(&mut OsRng);
        (*sk.public_key().as_bytes(), sk.to_bytes())
    }

    fn friend(ed: &str, name: Option<&str>) -> friends::Friend {
        friends::Friend {
            ed_pubkey_hex: ed.into(),
            x_pubkey_hex: format!("x-{ed}"),
            display_name: name.map(str::to_owned),
            paired_at: Some(1_700_000_000_000),
            last_studied_with: Some(1_700_000_100_000),
        }
    }

    #[test]
    fn backup_round_trips_through_seal_and_unseal() {
        let (pk, sk) = keypair();
        let rows = vec![friend("aa", Some("Alex")), friend("bb", None)];
        let bytes = encode_backup(&pk, &rows).expect("encode");
        assert!(bytes.starts_with(BACKUP_MAGIC));
        assert_eq!(bytes[BACKUP_MAGIC.len()], BACKUP_VERSION);
        let decoded = decode_backup(&sk, &bytes).expect("decode");
        assert_eq!(decoded.len(), 2);
        assert_eq!(decoded[0].ed_pubkey_hex, "aa");
        assert_eq!(decoded[0].display_name.as_deref(), Some("Alex"));
        assert_eq!(decoded[1].display_name, None);
        assert_eq!(decoded[1].last_studied_with, Some(1_700_000_100_000));
    }

    #[test]
    fn decode_rejects_a_different_identitys_key() {
        let (pk, _) = keypair();
        let (_, other_sk) = keypair();
        let bytes = encode_backup(&pk, &[friend("aa", None)]).expect("encode");
        assert!(decode_backup(&other_sk, &bytes).is_err());
    }

    #[test]
    fn decode_rejects_bad_magic_version_and_truncation() {
        let (pk, sk) = keypair();
        let bytes = encode_backup(&pk, &[friend("aa", None)]).expect("encode");

        let mut wrong_magic = bytes.clone();
        wrong_magic[0] ^= 0xff;
        assert!(decode_backup(&sk, &wrong_magic).is_err());

        let mut wrong_version = bytes;
        wrong_version[BACKUP_MAGIC.len()] = BACKUP_VERSION + 1;
        assert!(decode_backup(&sk, &wrong_version).is_err());

        assert!(decode_backup(&sk, BACKUP_MAGIC).is_err());
    }

    #[test]
    fn import_rows_counts_new_and_updated_and_upserts_fields() {
        let mut conn = fresh();
        friends::add(&conn, "aa", "x-old", "Old Name", 1).expect("preexisting");

        let result = import_rows(
            &mut conn,
            &[friend("aa", Some("Alex")), friend("bb", Some("Blake"))],
        )
        .expect("import");
        assert_eq!(result.imported, 1);
        assert_eq!(result.updated, 1);

        let listed = friends::list(&conn).expect("list");
        assert_eq!(listed.len(), 2);
        let aa = listed
            .iter()
            .find(|f| f.ed_pubkey_hex == "aa")
            .expect("aa present");
        assert_eq!(aa.display_name.as_deref(), Some("Alex"));
        assert_eq!(aa.x_pubkey_hex, "x-aa");
        assert_eq!(aa.paired_at, Some(1_700_000_000_000));
        assert_eq!(aa.last_studied_with, Some(1_700_000_100_000));
    }

    #[test]
    fn import_rows_is_empty_safe() {
        let mut conn = fresh();
        let result = import_rows(&mut conn, &[]).expect("import");
        assert_eq!(result.imported, 0);
        assert_eq!(result.updated, 0);
    }
}
