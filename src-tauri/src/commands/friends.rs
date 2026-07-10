//! Friends commands: thin sync wrappers over `db::friends`, plus the
//! encrypted `.svfb` friends-list backup (export/import, macOS/Windows only —
//! it needs the keychain identity). The backup's authenticity envelope is
//! security-critical; see the banner above `BACKUP_MAGIC` before touching the
//! format.

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
// X25519 key AND Ed25519-signed by the user's own identity key.
//
// The sealed box gives confidentiality only: anyone who knows the user's X25519
// PUBLIC key (every friend learns it during pairing) could otherwise craft a
// file that unseals cleanly with attacker-chosen rows, and the ed_pubkey upsert
// in `import_rows` would silently rewrite an existing friend's x_pubkey to an
// attacker key — hijacking the one channel invites are encrypted over. So the
// backup is also signed with the keychain Ed25519 key and verified on import
// against the user's own Ed25519 pubkey: only the identity owner can mint a
// backup this build will accept. The signature covers MAGIC || VERSION ||
// SEALED, binding the format bytes so a downgrade/reframe can't strip it.

const BACKUP_MAGIC: &[u8; 4] = b"SVFB";
// v2 adds the Ed25519 authenticity envelope. v1 (sealed-only) never shipped —
// the backup feature is new on this line — so there is no v1 file to migrate.
const BACKUP_VERSION: u8 = 2;
const BACKUP_SIG_LEN: usize = 64;
// Defensive bound on a hostile/corrupt .svfb: a real friends list is a handful
// of rows; cap the decoded count so an oversized file can't balloon memory.
const MAX_IMPORT_ROWS: usize = 10_000;

fn signed_prefix(version: u8, sealed: &[u8]) -> Vec<u8> {
    let mut msg = Vec::with_capacity(BACKUP_MAGIC.len() + 1 + sealed.len());
    msg.extend_from_slice(BACKUP_MAGIC);
    msg.push(version);
    msg.extend_from_slice(sealed);
    msg
}

fn encode_backup(
    signing_key: &ed25519_dalek::SigningKey,
    my_x_pub: &[u8; crate::crypto::X_KEY_LEN],
    rows: &[friends::Friend],
) -> Result<Vec<u8>, String> {
    use crypto_box::aead::OsRng;
    use ed25519_dalek::Signer;
    let json = serde_json::to_vec(rows).map_err(|e| format!("serialize friends: {e}"))?;
    let sealed = crypto_box::PublicKey::from(*my_x_pub)
        .seal(&mut OsRng, &json)
        .map_err(|_| "encrypt failed".to_string())?;
    let sig = signing_key.sign(&signed_prefix(BACKUP_VERSION, &sealed));
    let mut out = Vec::with_capacity(BACKUP_MAGIC.len() + 1 + BACKUP_SIG_LEN + sealed.len());
    out.extend_from_slice(BACKUP_MAGIC);
    out.push(BACKUP_VERSION);
    out.extend_from_slice(&sig.to_bytes());
    out.extend_from_slice(&sealed);
    Ok(out)
}

fn decode_backup(
    verifying_key: &ed25519_dalek::VerifyingKey,
    my_x_priv: &[u8; crate::crypto::X_KEY_LEN],
    bytes: &[u8],
) -> Result<Vec<friends::Friend>, String> {
    use ed25519_dalek::Verifier;
    let body = bytes
        .strip_prefix(BACKUP_MAGIC.as_slice())
        .ok_or("not a StudyVis friends backup file")?;
    let (&version, rest) = body.split_first().ok_or("truncated backup file")?;
    if version != BACKUP_VERSION {
        return Err(format!("unsupported backup format version {version}"));
    }
    if rest.len() < BACKUP_SIG_LEN {
        return Err("truncated backup file".to_string());
    }
    let (sig_bytes, sealed) = rest.split_at(BACKUP_SIG_LEN);
    let sig_arr: [u8; BACKUP_SIG_LEN] = sig_bytes
        .try_into()
        .map_err(|_| "truncated backup file".to_string())?;
    // Authenticity gate: reject any file not signed by THIS identity's Ed25519
    // key. A sealed box alone proves nothing about who produced the file.
    verifying_key
        .verify(
            &signed_prefix(version, sealed),
            &ed25519_dalek::Signature::from_bytes(&sig_arr),
        )
        .map_err(|_| "this backup belongs to a different identity".to_string())?;
    let json = crypto_box::SecretKey::from(*my_x_priv)
        .unseal(sealed)
        .map_err(|_| "decrypt failed: this backup belongs to a different identity".to_string())?;
    let rows: Vec<friends::Friend> =
        serde_json::from_slice(&json).map_err(|e| format!("parse friends: {e}"))?;
    if rows.len() > MAX_IMPORT_ROWS {
        return Err(format!(
            "backup has {} entries, exceeding the {MAX_IMPORT_ROWS} limit",
            rows.len()
        ));
    }
    for f in &rows {
        validate_pubkey_hex("ed_pubkey_hex", &f.ed_pubkey_hex)?;
        validate_pubkey_hex("x_pubkey_hex", &f.x_pubkey_hex)?;
    }
    Ok(rows)
}

// Reject a malformed key before it reaches the friends table: every stored key
// is a 32-byte value carried as lowercase hex. A backup row whose keys aren't
// well-formed hex of the right length is corrupt or hostile — fail the whole
// import rather than persist a junk row.
fn validate_pubkey_hex(label: &str, value: &str) -> Result<(), String> {
    let bytes = hex::decode(value).map_err(|_| format!("{label}: not valid hex"))?;
    if bytes.len() != crate::crypto::X_KEY_LEN {
        return Err(format!(
            "{label} must be {} bytes, got {}",
            crate::crypto::X_KEY_LEN,
            bytes.len()
        ));
    }
    Ok(())
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
    let signing_key = crate::commands::identity::load_ed_signing_key()?;
    let bytes = encode_backup(&signing_key, my_x_pub.as_bytes(), &rows)?;
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
    let verifying_key = crate::commands::identity::load_ed_signing_key()?.verifying_key();
    let rows = decode_backup(&verifying_key, &my_x_priv, &bytes)?;
    let mut conn = lock(&state)?;
    import_rows(&mut conn, &rows).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::migrations;
    use ed25519_dalek::{SigningKey, VerifyingKey};
    use rusqlite::Connection;

    fn fresh() -> Connection {
        let mut conn = Connection::open_in_memory().expect("open in-memory");
        migrations::run_migrations(&mut conn).expect("migrations");
        conn
    }

    fn x_keypair() -> ([u8; 32], [u8; 32]) {
        use crypto_box::aead::OsRng;
        let sk = crypto_box::SecretKey::generate(&mut OsRng);
        (*sk.public_key().as_bytes(), sk.to_bytes())
    }

    fn ed_keypair() -> (SigningKey, VerifyingKey) {
        // ed25519-dalek's `generate` needs its `rand_core` feature (off here),
        // so seed from OS randomness directly — same primitive identity.rs uses.
        use crypto_box::aead::{rand_core::RngCore, OsRng};
        let mut seed = [0u8; 32];
        OsRng.fill_bytes(&mut seed);
        let sk = SigningKey::from_bytes(&seed);
        let vk = sk.verifying_key();
        (sk, vk)
    }

    // A valid 32-byte key as lowercase hex, derived deterministically from a
    // seed byte so each `friend()` gets distinct, validation-passing keys.
    fn key_hex(seed: u8) -> String {
        hex::encode([seed; crate::crypto::X_KEY_LEN])
    }

    fn friend(seed: u8, name: Option<&str>) -> friends::Friend {
        friends::Friend {
            ed_pubkey_hex: key_hex(seed),
            x_pubkey_hex: key_hex(seed ^ 0xff),
            display_name: name.map(str::to_owned),
            paired_at: Some(1_700_000_000_000),
            last_studied_with: Some(1_700_000_100_000),
        }
    }

    #[test]
    fn backup_round_trips_through_seal_sign_and_verify() {
        let (x_pub, x_priv) = x_keypair();
        let (sign, verify) = ed_keypair();
        let rows = vec![friend(0xaa, Some("Alex")), friend(0xbb, None)];
        let bytes = encode_backup(&sign, &x_pub, &rows).expect("encode");
        assert!(bytes.starts_with(BACKUP_MAGIC));
        assert_eq!(bytes[BACKUP_MAGIC.len()], BACKUP_VERSION);
        let decoded = decode_backup(&verify, &x_priv, &bytes).expect("decode");
        assert_eq!(decoded.len(), 2);
        assert_eq!(decoded[0].ed_pubkey_hex, key_hex(0xaa));
        assert_eq!(decoded[0].display_name.as_deref(), Some("Alex"));
        assert_eq!(decoded[1].display_name, None);
        assert_eq!(decoded[1].last_studied_with, Some(1_700_000_100_000));
    }

    #[test]
    fn decode_rejects_a_different_identitys_seal_key() {
        let (x_pub, _) = x_keypair();
        let (sign, verify) = ed_keypair();
        let (_, other_x_priv) = x_keypair();
        let bytes = encode_backup(&sign, &x_pub, &[friend(0xaa, None)]).expect("encode");
        // Right signature, wrong unseal key — must not decrypt.
        assert!(decode_backup(&verify, &other_x_priv, &bytes).is_err());
    }

    // The core authenticity property: a file sealed to the victim's X25519
    // PUBLIC key (which every friend knows) but NOT signed by the victim's
    // Ed25519 key must be rejected — even though it unseals cleanly. This is
    // exactly the forged-backup / friend-hijack attack the signature closes.
    #[test]
    fn decode_rejects_a_sealed_but_unsigned_backup() {
        let (x_pub, x_priv) = x_keypair();
        let (victim_sign, victim_verify) = ed_keypair();
        // Attacker signs with their OWN ed key but seals to the victim's x pub.
        let (attacker_sign, _) = ed_keypair();
        let forged = encode_backup(&attacker_sign, &x_pub, &[friend(0xcc, Some("Mallory"))])
            .expect("encode");
        // Confirms the seal itself opens (the attacker only needs the public key)…
        assert!(crypto_box::SecretKey::from(x_priv)
            .unseal(&forged[BACKUP_MAGIC.len() + 1 + BACKUP_SIG_LEN..])
            .is_ok());
        // …yet verification against the victim's ed pubkey fails, so import refuses.
        assert!(decode_backup(&victim_verify, &x_priv, &forged).is_err());
        // The victim's own backup still round-trips.
        let genuine = encode_backup(&victim_sign, &x_pub, &[friend(0xaa, None)]).expect("encode");
        assert!(decode_backup(&victim_verify, &x_priv, &genuine).is_ok());
    }

    #[test]
    fn decode_rejects_bad_magic_version_and_truncation() {
        let (x_pub, x_priv) = x_keypair();
        let (sign, verify) = ed_keypair();
        let bytes = encode_backup(&sign, &x_pub, &[friend(0xaa, None)]).expect("encode");

        let mut wrong_magic = bytes.clone();
        wrong_magic[0] ^= 0xff;
        assert!(decode_backup(&verify, &x_priv, &wrong_magic).is_err());

        let mut wrong_version = bytes.clone();
        wrong_version[BACKUP_MAGIC.len()] = BACKUP_VERSION + 1;
        assert!(decode_backup(&verify, &x_priv, &wrong_version).is_err());

        assert!(decode_backup(&verify, &x_priv, BACKUP_MAGIC).is_err());

        // A file with valid magic+version but no room for a signature.
        let mut sig_truncated = Vec::from(BACKUP_MAGIC.as_slice());
        sig_truncated.push(BACKUP_VERSION);
        sig_truncated.extend_from_slice(&[0u8; BACKUP_SIG_LEN - 1]);
        assert!(decode_backup(&verify, &x_priv, &sig_truncated).is_err());

        // Flipping a byte inside the sealed body invalidates the signature.
        let mut tampered = bytes;
        let last = tampered.len() - 1;
        tampered[last] ^= 0xff;
        assert!(decode_backup(&verify, &x_priv, &tampered).is_err());
    }

    #[test]
    fn decode_rejects_malformed_key_hex() {
        let (x_pub, x_priv) = x_keypair();
        let (sign, verify) = ed_keypair();
        let mut bad = friend(0xaa, None);
        bad.x_pubkey_hex = "x-not-hex".into();
        let bytes = encode_backup(&sign, &x_pub, &[bad]).expect("encode");
        // Signature + seal are valid; the row's key is junk, so import refuses.
        assert!(decode_backup(&verify, &x_priv, &bytes).is_err());
    }

    #[test]
    fn decode_rejects_an_oversized_row_count() {
        let (x_pub, x_priv) = x_keypair();
        let (sign, verify) = ed_keypair();
        let rows: Vec<friends::Friend> = (0..MAX_IMPORT_ROWS + 1)
            .map(|i| friend((i % 256) as u8, None))
            .collect();
        let bytes = encode_backup(&sign, &x_pub, &rows).expect("encode");
        assert!(decode_backup(&verify, &x_priv, &bytes).is_err());
    }

    #[test]
    fn import_rows_counts_new_and_updated_and_upserts_fields() {
        let mut conn = fresh();
        let aa = key_hex(0xaa);
        let x_aa = key_hex(0xaa ^ 0xff);
        friends::add(&conn, &aa, "x-old", "Old Name", 1).expect("preexisting");

        let result = import_rows(
            &mut conn,
            &[friend(0xaa, Some("Alex")), friend(0xbb, Some("Blake"))],
        )
        .expect("import");
        assert_eq!(result.imported, 1);
        assert_eq!(result.updated, 1);

        let listed = friends::list(&conn).expect("list");
        assert_eq!(listed.len(), 2);
        let row = listed
            .iter()
            .find(|f| f.ed_pubkey_hex == aa)
            .expect("aa present");
        assert_eq!(row.display_name.as_deref(), Some("Alex"));
        assert_eq!(row.x_pubkey_hex, x_aa);
        assert_eq!(row.paired_at, Some(1_700_000_000_000));
        assert_eq!(row.last_studied_with, Some(1_700_000_100_000));
    }

    #[test]
    fn import_rows_is_empty_safe() {
        let mut conn = fresh();
        let result = import_rows(&mut conn, &[]).expect("import");
        assert_eq!(result.imported, 0);
        assert_eq!(result.updated, 0);
    }
}
