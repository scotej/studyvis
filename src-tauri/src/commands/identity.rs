//! Identity commands: keychain custody of the private keys, the public
//! `identity.json` record, and keyring-backed sign / box-encrypt / decrypt.
//!
//! Key custody model: the Ed25519 + X25519 private keys (both HKDF-derived
//! from the 24-word mnemonic on the JS side — see `src/lib/crypto/identity.ts`)
//! are submitted to Rust at save/recovery time (`identity_save_keys` accepts
//! idempotent retries and, on the confirmed recovery path, explicit
//! overwrites) and are retained in the OS keychain (service
//! `com.studyvis.app`, user `identity-keys`) — never on plaintext disk. JS
//! asks Rust to sign/open-box on its behalf afterwards. The module compiles
//! wherever `keyring` has a backend wired (`commands/mod.rs`): Keychain on
//! macOS, Credential Manager on Windows, Secret Service on Linux. Nothing in
//! here is platform-specific — only the backend behind `Entry` differs.
//!
//! `identity.json` (public keys + display name + fingerprint) lives in the
//! SQLite data dir, NOT the Tauri `app_data_dir` that holds `settings.json`.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

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
// #404: worker dispatch must preserve the former single-writer operations.
static IDENTITY_RECORD_LOCK: Mutex<()> = Mutex::new(());
static IDENTITY_KEYS_LOCK: Mutex<()> = Mutex::new(());
pub(crate) const LINUX_SECRET_SERVICE_ERROR_MARKER: &str =
    "Linux Secret Service is unavailable or locked";

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

pub(crate) fn format_keyring_error(context: &str, error: keyring::Error) -> String {
    #[cfg(target_os = "linux")]
    {
        format!(
            "{LINUX_SECRET_SERVICE_ERROR_MARKER}. Start or unlock gnome-keyring, KWallet, or another org.freedesktop.secrets provider, then try again ({context}: {error})"
        )
    }
    #[cfg(not(target_os = "linux"))]
    {
        format!("{context}: {error}")
    }
}

fn keys_entry() -> Result<Entry, String> {
    Entry::new(KEYRING_SERVICE, KEYRING_USER).map_err(|e| format_keyring_error("open keyring", e))
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
    let payload = keys_entry()?
        .get_password()
        .map_err(|e| format_keyring_error("read identity keys", e))?;
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

// The user's own Ed25519 signing key, used to authenticate locally-produced
// artifacts the keychain owner alone should be able to mint (e.g. the friends
// backup). Mirrors `load_x_priv` — the keychain is the single source of truth,
// so a backup signed here is verifiable only against this identity's pubkey.
pub(crate) fn load_ed_signing_key() -> Result<SigningKey, String> {
    let stored = load_stored()?;
    let bytes = hex::decode(&stored.ed_priv_hex).map_err(|e| e.to_string())?;
    let arr: [u8; PRIV_KEY_LEN] = bytes
        .as_slice()
        .try_into()
        .map_err(|_| format!("ed25519 priv key must be {PRIV_KEY_LEN} bytes"))?;
    Ok(SigningKey::from_bytes(&arr))
}

pub(crate) fn load_backup_keys() -> Result<([u8; X_KEY_LEN], SigningKey), String> {
    let _guard = IDENTITY_KEYS_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    Ok((load_x_priv()?, load_ed_signing_key()?))
}

// Stable substring the frontend matches to swap the generic save-identity
// toast for "go back and restore from your backup" steering (see KEYS_EXIST_MARKER
// in src/features/identity/IdentitySetup.tsx). Keep the two in sync.
pub(crate) const KEYS_EXIST_MARKER: &str = "identity keys already exist";

// D1 belt-and-braces: refuse to clobber existing keychain keys unless the
// caller explicitly opts in (`overwrite`). New-identity creation passes false,
// so a corrupt identity.json load can never silently overwrite a still-valid
// keypair and strand the friends who know the old pubkey; recovery — which has
// shown the overwrite confirm — passes true.
//
// Idempotency carve-out: when the stored payload is byte-for-byte the incoming
// keys, writing them again is a no-op, so we accept it even with overwrite=false.
// This unsticks the create path when a crash lands between save_keys and
// save_record (orphaned keychain entry, no identity.json): re-running the SAME
// create succeeds instead of dead-ending on the refuse-to-overwrite error.
#[tauri::command]
pub async fn identity_save_keys(
    ed_priv_hex: String,
    x_priv_hex: String,
    overwrite: bool,
) -> Result<(), String> {
    super::blocking(move || {
        validate_priv_hex("ed_priv_hex", &ed_priv_hex)?;
        validate_priv_hex("x_priv_hex", &x_priv_hex)?;
        let payload = serde_json::to_string(&StoredKeys {
            ed_priv_hex,
            x_priv_hex,
        })
        .map_err(|e| e.to_string())?;
        save_keys_in_entry(&keys_entry()?, &payload, overwrite)
    })
    .await
}

fn save_keys_in_entry(entry: &Entry, payload: &str, overwrite: bool) -> Result<(), String> {
    let _guard = IDENTITY_KEYS_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    if !overwrite {
        match entry.get_password() {
            Ok(existing) if existing == payload => return Ok(()),
            Ok(_) => {
                return Err(format!(
                    "{KEYS_EXIST_MARKER}; refusing to overwrite without confirmation"
                ))
            }
            Err(keyring::Error::NoEntry) => {}
            Err(e) => return Err(format_keyring_error("read identity keys", e)),
        }
    }
    entry
        .set_password(payload)
        .map_err(|e| format_keyring_error("save identity keys", e))?;
    Ok(())
}

#[tauri::command]
pub async fn identity_exists(app: AppHandle) -> Result<bool, String> {
    super::blocking(move || {
        let path = identity_path(&app)?;
        Ok(path.exists())
    })
    .await
}

// #47 E1 — cheap boot probe (mirrors hf_token_present): does the keychain
// actually hold this identity's private keys? `identity.json` alone proving
// 'ready' let a restored file over a wiped/reset keychain boot normally and
// then fail deep inside pairing/invites/audit signing with raw keyring
// errors. Only `NoEntry` maps to false — any other keyring error (locked
// keychain, access denied) is NOT "keys absent" and must not steer the user
// toward the key-overwriting Recover flow, so it surfaces as Err and the
// caller treats the probe as inconclusive.
#[tauri::command]
pub async fn identity_keys_present() -> Result<bool, String> {
    super::blocking(move || match keys_entry()?.get_password() {
        Ok(_) => Ok(true),
        Err(keyring::Error::NoEntry) => Ok(false),
        Err(e) => Err(format_keyring_error("read identity keys", e)),
    })
    .await
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum IdentityKeysStatus {
    Matching,
    Missing,
    Invalid,
}

fn check_stored_keys(payload: &str, record: &IdentityRecord) -> IdentityKeysStatus {
    let matches = (|| -> Option<bool> {
        let stored: StoredKeys = serde_json::from_str(payload).ok()?;
        let ed_private: [u8; PRIV_KEY_LEN] =
            hex::decode(stored.ed_priv_hex).ok()?.try_into().ok()?;
        let x_private: [u8; PRIV_KEY_LEN] = hex::decode(stored.x_priv_hex).ok()?.try_into().ok()?;
        let ed_public: [u8; PRIV_KEY_LEN] =
            hex::decode(&record.ed_pubkey_hex).ok()?.try_into().ok()?;
        let x_public: [u8; PRIV_KEY_LEN] =
            hex::decode(&record.x_pubkey_hex).ok()?.try_into().ok()?;
        Some(
            SigningKey::from_bytes(&ed_private)
                .verifying_key()
                .to_bytes()
                == ed_public
                && crypto_box::SecretKey::from(x_private)
                    .public_key()
                    .as_bytes()
                    == &x_public,
        )
    })();
    if matches == Some(true) {
        IdentityKeysStatus::Matching
    } else {
        IdentityKeysStatus::Invalid
    }
}

// #380: possession alone does not prove identity.json describes the credential.
// Derive and compare both public keys without returning private material to JS.
#[tauri::command]
pub async fn identity_keys_status(record: IdentityRecord) -> Result<IdentityKeysStatus, String> {
    super::blocking(move || identity_keys_status_from_entry(&keys_entry()?, &record)).await
}

fn identity_keys_status_from_entry(
    entry: &Entry,
    record: &IdentityRecord,
) -> Result<IdentityKeysStatus, String> {
    match entry.get_password() {
        Ok(payload) => Ok(check_stored_keys(&payload, record)),
        Err(keyring::Error::NoEntry) => Ok(IdentityKeysStatus::Missing),
        Err(error) => Err(format_keyring_error("read identity keys", error)),
    }
}

#[tauri::command]
pub async fn identity_save_record(app: AppHandle, record: IdentityRecord) -> Result<(), String> {
    super::blocking(move || save_record_at(&identity_path(&app)?, &record)).await
}

fn save_record_at(path: &Path, record: &IdentityRecord) -> Result<(), String> {
    let _guard = IDENTITY_RECORD_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let json = serde_json::to_vec_pretty(record).map_err(|e| e.to_string())?;
    // Atomic: write a sibling temp file then rename over the target, so a
    // crash mid-write can't leave a truncated identity.json that boot would
    // treat as "no identity" while the private keys sit orphaned in the
    // keychain (I16; mitigates I15). rename is atomic on the same FS.
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, &json).map_err(|e| format!("write {}: {e}", tmp.display()))?;
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("rename {} -> {}: {e}", tmp.display(), path.display())
    })?;
    Ok(())
}

#[tauri::command]
pub async fn identity_load_record(app: AppHandle) -> Result<Option<IdentityRecord>, String> {
    super::blocking(move || {
        let path = identity_path(&app)?;
        let _guard = IDENTITY_RECORD_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if !path.exists() {
            return Ok(None);
        }
        let bytes = fs::read(&path).map_err(|e| format!("read {}: {e}", path.display()))?;
        let record: IdentityRecord = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
        Ok(Some(record))
    })
    .await
}

#[tauri::command]
pub async fn identity_sign(message: Vec<u8>) -> Result<Vec<u8>, String> {
    super::blocking(move || {
        let stored = load_stored()?;
        let priv_bytes = hex::decode(&stored.ed_priv_hex).map_err(|e| e.to_string())?;
        let priv_arr: [u8; PRIV_KEY_LEN] = priv_bytes
            .as_slice()
            .try_into()
            .map_err(|_| format!("ed25519 priv key must be {PRIV_KEY_LEN} bytes"))?;
        let signing_key = SigningKey::from_bytes(&priv_arr);
        let sig = signing_key.sign(&message);
        Ok(sig.to_bytes().to_vec())
    })
    .await
}

#[tauri::command]
pub async fn identity_box_decrypt(
    their_x_pub_hex: String,
    nonce_b64: String,
    ciphertext_b64: String,
) -> Result<Vec<u8>, String> {
    super::blocking(move || {
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
    })
    .await
}

#[derive(Debug, Serialize)]
pub struct BoxCiphertext {
    pub nonce_b64: String,
    pub ciphertext_b64: String,
}

fn encrypt_box_with_keys(
    their_x_pub: &[u8; X_KEY_LEN],
    my_x_priv: &[u8; X_KEY_LEN],
    plaintext: &[u8],
) -> Result<BoxCiphertext, String> {
    use crypto_box::{
        aead::{AeadCore, OsRng},
        SalsaBox,
    };

    let nonce: [u8; NONCE_LEN] = SalsaBox::generate_nonce(&mut OsRng).into();
    let ciphertext = nacl_box_encrypt(their_x_pub, my_x_priv, &nonce, plaintext)?;
    Ok(BoxCiphertext {
        nonce_b64: BASE64.encode(nonce),
        ciphertext_b64: BASE64.encode(&ciphertext),
    })
}

#[tauri::command]
pub async fn identity_box_encrypt(
    their_x_pub_hex: String,
    plaintext: Vec<u8>,
) -> Result<BoxCiphertext, String> {
    super::blocking(move || {
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

        encrypt_box_with_keys(&their_pub_arr, &my_priv_arr, &plaintext)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::{
        check_stored_keys, identity_keys_status_from_entry, save_keys_in_entry, save_record_at,
        Entry, IdentityKeysStatus, IdentityRecord, StoredKeys, KEYS_EXIST_MARKER,
    };

    #[test]
    fn encrypted_boxes_use_fresh_nonces_and_keep_the_nacl_wire_format() {
        use base64::Engine as _;
        let sender_private = [7u8; crate::crypto::X_KEY_LEN];
        let recipient_private = [9u8; crate::crypto::X_KEY_LEN];
        let sender_public = crypto_box::SecretKey::from(sender_private).public_key();
        let recipient_public = crypto_box::SecretKey::from(recipient_private).public_key();
        let plaintext = b"same message, independent envelopes";
        let mut nonces = std::collections::HashSet::new();
        let mut ciphertexts = std::collections::HashSet::new();
        for _ in 0..32 {
            let wire = super::encrypt_box_with_keys(
                recipient_public.as_bytes(),
                &sender_private,
                plaintext,
            )
            .unwrap();
            let nonce: [u8; crate::crypto::NONCE_LEN] = super::BASE64
                .decode(&wire.nonce_b64)
                .unwrap()
                .try_into()
                .unwrap();
            let ciphertext = super::BASE64.decode(&wire.ciphertext_b64).unwrap();
            assert_eq!(ciphertext.len(), plaintext.len() + 16);
            assert_eq!(
                crate::crypto::nacl_box_decrypt(
                    sender_public.as_bytes(),
                    &recipient_private,
                    &nonce,
                    &ciphertext
                )
                .unwrap(),
                plaintext
            );
            assert!(
                nonces.insert(nonce),
                "independent envelopes must use fresh nonces"
            );
            assert!(
                ciphertexts.insert(ciphertext),
                "repeating the message must produce independent ciphertexts"
            );
        }
    }

    fn key_fixture(ed: u8, x: u8) -> (String, IdentityRecord) {
        let ed_private = [ed; 32];
        let x_private = [x; 32];
        let payload = serde_json::to_string(&StoredKeys {
            ed_priv_hex: hex::encode(ed_private),
            x_priv_hex: hex::encode(x_private),
        })
        .unwrap();
        let record = IdentityRecord {
            version: 1,
            ed_pubkey_hex: hex::encode(
                ed25519_dalek::SigningKey::from_bytes(&ed_private)
                    .verifying_key()
                    .to_bytes(),
            ),
            x_pubkey_hex: hex::encode(
                crypto_box::SecretKey::from(x_private)
                    .public_key()
                    .as_bytes(),
            ),
            display_name: "Test".into(),
            created_at: 0,
            mnemonic_fingerprint: "test".into(),
        };
        (payload, record)
    }

    #[test]
    fn identity_coherence_requires_both_key_pairs() {
        let (payload, record) = key_fixture(1, 2);
        assert_eq!(
            check_stored_keys(&payload, &record),
            IdentityKeysStatus::Matching
        );
        let (_, other) = key_fixture(3, 4);
        assert_eq!(
            check_stored_keys(&payload, &other),
            IdentityKeysStatus::Invalid
        );
        let only_x_differs = IdentityRecord {
            x_pubkey_hex: other.x_pubkey_hex.clone(),
            ..record.clone()
        };
        assert_eq!(
            check_stored_keys(&payload, &only_x_differs),
            IdentityKeysStatus::Invalid
        );
        let only_ed_differs = IdentityRecord {
            ed_pubkey_hex: other.ed_pubkey_hex.clone(),
            ..record
        };
        assert_eq!(
            check_stored_keys(&payload, &only_ed_differs),
            IdentityKeysStatus::Invalid
        );
    }

    #[test]
    fn malformed_identity_keys_are_recoverable() {
        let (_, record) = key_fixture(1, 2);
        for payload in [
            "invalid",
            "{}",
            r#"{"ed_priv_hex":"00", "x_priv_hex":"00"}"#,
            r#"{"ed_priv_hex":"zz", "x_priv_hex":"ff"}"#,
        ] {
            assert_eq!(
                check_stored_keys(payload, &record),
                IdentityKeysStatus::Invalid
            );
        }
    }

    #[test]
    fn concurrent_record_saves_remain_atomic_and_all_complete() {
        let dir = std::env::temp_dir().join(format!(
            "studyvis-identity-writers-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("identity.json");
        let record = |writer: i64, iteration: i64| IdentityRecord {
            version: 1,
            ed_pubkey_hex: format!("{writer:064x}"),
            x_pubkey_hex: format!("{iteration:064x}"),
            display_name: format!("writer {writer} revision {iteration}"),
            created_at: writer * 1000 + iteration,
            mnemonic_fingerprint: format!("{writer}-{iteration}"),
        };
        save_record_at(&path, &record(0, 0)).unwrap();
        let start = std::sync::Barrier::new(9);
        std::thread::scope(|scope| {
            let mut writers = Vec::new();
            for writer in 1..=8 {
                let path = &path;
                let start = &start;
                let record = &record;
                writers.push(scope.spawn(move || {
                    start.wait();
                    for iteration in 0..32 {
                        save_record_at(path, &record(writer, iteration)).unwrap();
                    }
                }));
            }
            start.wait();
            // Read the real destination without the writer mutex: rename must
            // expose one complete profile throughout the competing writes.
            for _ in 0..256 {
                let saved: IdentityRecord =
                    serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
                let expected = record(saved.created_at / 1000, saved.created_at % 1000);
                assert_eq!(
                    serde_json::to_value(saved).unwrap(),
                    serde_json::to_value(expected).unwrap()
                );
            }
            for writer in writers {
                writer.join().unwrap();
            }
        });
        assert!(!path.with_extension("json.tmp").exists());
        std::fs::remove_dir_all(dir).unwrap();
    }

    struct IsolatedCredential(Entry);

    impl Drop for IsolatedCredential {
        fn drop(&mut self) {
            let _ = self.0.delete_credential();
        }
    }

    fn credential_store_round_trip() {
        let unique = format!(
            "com.studyvis.app.smoke.{}.{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock must be after Unix epoch")
                .as_nanos()
        );
        let isolated = IsolatedCredential(
            Entry::new(&unique, "identity-keys")
                .expect("create isolated native credential-store entry"),
        );
        let entry = &isolated.0;
        assert!(matches!(entry.get_password(), Err(keyring::Error::NoEntry)));
        let secret = format!("studyvis-credential-smoke-{}", std::process::id());

        entry
            .set_password(&secret)
            .expect("write through the native keyring backend");
        assert_eq!(
            entry
                .get_password()
                .expect("read through the native keyring backend"),
            secret
        );
        let replacement = format!("{secret}-updated");
        entry
            .set_password(&replacement)
            .expect("update the isolated native credential");
        let reopened = Entry::new(&unique, "identity-keys").expect("reopen isolated credential");
        assert_eq!(
            reopened.get_password().expect("read after reopening"),
            replacement
        );
        let (payload, record) = key_fixture(1, 2);
        entry
            .set_password(&payload)
            .expect("save isolated identity keys");
        assert_eq!(
            identity_keys_status_from_entry(entry, &record).unwrap(),
            IdentityKeysStatus::Matching
        );
        let (_, other_record) = key_fixture(3, 4);
        assert_eq!(
            identity_keys_status_from_entry(entry, &other_record).unwrap(),
            IdentityKeysStatus::Invalid
        );
        entry
            .set_password("malformed")
            .expect("save isolated malformed fixture");
        assert_eq!(
            identity_keys_status_from_entry(entry, &record).unwrap(),
            IdentityKeysStatus::Invalid
        );
        entry
            .delete_credential()
            .expect("clear before concurrent create");
        let start = std::sync::Barrier::new(2);
        let results = std::thread::scope(|scope| {
            let first = scope.spawn(|| {
                start.wait();
                save_keys_in_entry(entry, "first isolated keys", false)
            });
            let second = scope.spawn(|| {
                start.wait();
                save_keys_in_entry(entry, "second isolated keys", false)
            });
            [first.join().unwrap(), second.join().unwrap()]
        });
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        assert!(results
            .iter()
            .filter_map(|result| result.as_ref().err())
            .all(|error| error.contains(KEYS_EXIST_MARKER)));
        let retained = entry.get_password().unwrap();
        assert!(retained == "first isolated keys" || retained == "second isolated keys");
        save_keys_in_entry(entry, &retained, false).expect("idempotent create remains accepted");
        entry
            .delete_credential()
            .expect("delete isolated native credential-store entry");
        assert!(matches!(entry.get_password(), Err(keyring::Error::NoEntry)));
        assert_eq!(
            identity_keys_status_from_entry(entry, &record).unwrap(),
            IdentityKeysStatus::Missing
        );
    }

    // Separate opt-in tests retain Linux's isolated-session invocation and
    // exercise the actual Keychain/Credential Manager backends on hosted CI.
    // The unique service and Drop guard never read or modify production keys.
    #[cfg(target_os = "linux")]
    #[test]
    #[ignore = "requires a live Linux Secret Service session"]
    fn secret_service_round_trip() {
        credential_store_round_trip();
    }

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    #[test]
    #[ignore = "requires an available native credential store"]
    fn native_credential_store_round_trip() {
        credential_store_round_trip();
    }
}
