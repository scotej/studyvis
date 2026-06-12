use std::fs;
use std::path::PathBuf;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use ed25519_dalek::{Signer, SigningKey};
use keyring::Entry;
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::crypto::{nacl_box_decrypt, nacl_box_encrypt, NONCE_LEN, X_KEY_LEN};
use crate::db;

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

fn identity_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(db::data_dir(app)?.join(IDENTITY_FILE))
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

pub(crate) fn load_x_priv() -> Result<[u8; X_KEY_LEN], String> {
    let stored = load_stored()?;
    let bytes = hex::decode(&stored.x_priv_hex).map_err(|e| e.to_string())?;
    bytes
        .as_slice()
        .try_into()
        .map_err(|_| format!("x25519 priv key must be {PRIV_KEY_LEN} bytes"))
}

#[tauri::command]
pub fn identity_save_keys(ed_priv_hex: String, x_priv_hex: String) -> Result<(), String> {
    validate_priv_hex("ed_priv_hex", &ed_priv_hex)?;
    validate_priv_hex("x_priv_hex", &x_priv_hex)?;
    let payload = serde_json::to_string(&StoredKeys {
        ed_priv_hex,
        x_priv_hex,
    })
    .map_err(|e| e.to_string())?;
    keys_entry()?
        .set_password(&payload)
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn identity_exists(app: AppHandle) -> Result<bool, String> {
    let path = identity_path(&app)?;
    Ok(path.exists())
}

#[tauri::command]
pub fn identity_save_record(app: AppHandle, record: IdentityRecord) -> Result<(), String> {
    let path = identity_path(&app)?;
    let json = serde_json::to_vec_pretty(&record).map_err(|e| e.to_string())?;
    // Atomic: write a sibling temp file then rename over the target, so a
    // crash mid-write can't leave a truncated identity.json that boot would
    // treat as "no identity" while the private keys sit orphaned in the
    // keychain (I16; mitigates I15). rename is atomic on the same FS.
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, &json).map_err(|e| format!("write {}: {e}", tmp.display()))?;
    fs::rename(&tmp, &path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("rename {} -> {}: {e}", tmp.display(), path.display())
    })?;
    Ok(())
}

#[tauri::command]
pub fn identity_load_record(app: AppHandle) -> Result<Option<IdentityRecord>, String> {
    let path = identity_path(&app)?;
    if !path.exists() {
        return Ok(None);
    }
    let bytes = fs::read(&path).map_err(|e| format!("read {}: {e}", path.display()))?;
    let record: IdentityRecord = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    Ok(Some(record))
}

#[tauri::command]
pub fn identity_sign(message: Vec<u8>) -> Result<Vec<u8>, String> {
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

#[tauri::command]
pub fn identity_box_decrypt(
    their_x_pub_hex: String,
    nonce_b64: String,
    ciphertext_b64: String,
) -> Result<Vec<u8>, String> {
    let their_pub_bytes = hex::decode(&their_x_pub_hex).map_err(|e| e.to_string())?;
    let their_pub_arr: [u8; X_KEY_LEN] = their_pub_bytes
        .as_slice()
        .try_into()
        .map_err(|_| format!("their_x_pub must decode to {X_KEY_LEN} bytes"))?;
    let nonce_bytes = BASE64
        .decode(nonce_b64.as_bytes())
        .map_err(|e| format!("nonce base64: {e}"))?;
    let nonce_arr: [u8; NONCE_LEN] = nonce_bytes
        .as_slice()
        .try_into()
        .map_err(|_| format!("nonce must decode to {NONCE_LEN} bytes"))?;
    let ciphertext = BASE64
        .decode(ciphertext_b64.as_bytes())
        .map_err(|e| format!("ciphertext base64: {e}"))?;

    let stored = load_stored()?;
    let my_priv_bytes = hex::decode(&stored.x_priv_hex).map_err(|e| e.to_string())?;
    let my_priv_arr: [u8; PRIV_KEY_LEN] = my_priv_bytes
        .as_slice()
        .try_into()
        .map_err(|_| format!("x25519 priv key must be {PRIV_KEY_LEN} bytes"))?;

    nacl_box_decrypt(&their_pub_arr, &my_priv_arr, &nonce_arr, &ciphertext)
}

#[derive(Debug, Serialize)]
pub struct BoxCiphertext {
    pub nonce_b64: String,
    pub ciphertext_b64: String,
}

#[tauri::command]
pub fn identity_box_encrypt(
    their_x_pub_hex: String,
    plaintext: Vec<u8>,
) -> Result<BoxCiphertext, String> {
    let their_pub_bytes = hex::decode(&their_x_pub_hex).map_err(|e| e.to_string())?;
    let their_pub_arr: [u8; X_KEY_LEN] = their_pub_bytes
        .as_slice()
        .try_into()
        .map_err(|_| format!("their_x_pub must decode to {X_KEY_LEN} bytes"))?;

    let stored = load_stored()?;
    let my_priv_bytes = hex::decode(&stored.x_priv_hex).map_err(|e| e.to_string())?;
    let my_priv_arr: [u8; PRIV_KEY_LEN] = my_priv_bytes
        .as_slice()
        .try_into()
        .map_err(|_| format!("x25519 priv key must be {PRIV_KEY_LEN} bytes"))?;

    use crypto_box::aead::{rand_core::RngCore, OsRng};
    let mut nonce = [0u8; NONCE_LEN];
    OsRng.fill_bytes(&mut nonce);

    let ciphertext = nacl_box_encrypt(&their_pub_arr, &my_priv_arr, &nonce, &plaintext)?;

    Ok(BoxCiphertext {
        nonce_b64: BASE64.encode(nonce),
        ciphertext_b64: BASE64.encode(&ciphertext),
    })
}
