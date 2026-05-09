use std::fs;
use std::path::PathBuf;

use ed25519_dalek::{Signer, SigningKey};
use keyring::Entry;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

const KEYRING_SERVICE: &str = "com.studyvis.app";
const KEYRING_USER: &str = "identity-keys";
const IDENTITY_FILE: &str = "identity.json";
const PRIV_KEY_LEN: usize = 32;

#[derive(Debug, Serialize, Deserialize)]
pub struct StoredKeys {
    pub ed_priv_hex: String,
    pub x_priv_hex: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct IdentityRecord {
    pub version: u32,
    pub ed_pubkey_hex: String,
    pub x_pubkey_hex: String,
    pub display_name: String,
    pub created_at: i64,
    pub mnemonic_fingerprint: String,
}

fn keys_entry() -> Result<Entry, String> {
    Entry::new(KEYRING_SERVICE, KEYRING_USER).map_err(|e| e.to_string())
}

fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .data_dir()
        .map_err(|e| format!("data_dir: {e}"))?;
    let dir = base.join("studyvis");
    fs::create_dir_all(&dir).map_err(|e| format!("create_dir_all: {e}"))?;
    Ok(dir)
}

fn identity_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(data_dir(app)?.join(IDENTITY_FILE))
}

fn validate_priv_hex(label: &str, value: &str) -> Result<(), String> {
    let bytes = hex::decode(value).map_err(|e| format!("{label}: {e}"))?;
    if bytes.len() != PRIV_KEY_LEN {
        return Err(format!(
            "{label} must decode to {PRIV_KEY_LEN} bytes, got {}",
            bytes.len()
        ));
    }
    Ok(())
}

fn load_stored() -> Result<StoredKeys, String> {
    let payload = keys_entry()?.get_password().map_err(|e| e.to_string())?;
    serde_json::from_str(&payload).map_err(|e| format!("parse stored keys: {e}"))
}

#[tauri::command]
pub async fn identity_save_keys(
    ed_priv_hex: String,
    x_priv_hex: String,
) -> Result<(), String> {
    validate_priv_hex("ed_priv_hex", &ed_priv_hex)?;
    validate_priv_hex("x_priv_hex", &x_priv_hex)?;
    let payload = serde_json::to_string(&StoredKeys {
        ed_priv_hex,
        x_priv_hex,
    })
    .map_err(|e| e.to_string())?;
    keys_entry()?.set_password(&payload).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn identity_exists(app: AppHandle) -> Result<bool, String> {
    let path = identity_path(&app)?;
    Ok(path.exists())
}

#[tauri::command]
pub async fn identity_save_record(
    app: AppHandle,
    record: IdentityRecord,
) -> Result<(), String> {
    let path = identity_path(&app)?;
    let json = serde_json::to_vec_pretty(&record).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| format!("write {}: {e}", path.display()))?;
    Ok(())
}

#[tauri::command]
pub async fn identity_load_record(
    app: AppHandle,
) -> Result<Option<IdentityRecord>, String> {
    let path = identity_path(&app)?;
    if !path.exists() {
        return Ok(None);
    }
    let bytes = fs::read(&path).map_err(|e| format!("read {}: {e}", path.display()))?;
    let record: IdentityRecord = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    Ok(Some(record))
}

#[tauri::command]
pub async fn identity_sign(message: Vec<u8>) -> Result<Vec<u8>, String> {
    let stored = load_stored()?;
    let priv_bytes = hex::decode(&stored.ed_priv_hex).map_err(|e| e.to_string())?;
    let priv_arr: [u8; PRIV_KEY_LEN] = priv_bytes
        .as_slice()
        .try_into()
        .map_err(|_| format!("ed25519 priv key must be {PRIV_KEY_LEN} bytes"))?;
    let signing_key = SigningKey::from_bytes(&priv_arr);
    let sig = signing_key.sign(&message);
    Ok(sig.to_bytes().to_vec())
}
