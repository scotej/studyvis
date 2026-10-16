#[cfg(target_os = "linux")]
pub use studyvis_lib::{crypto, db};

#[cfg(target_os = "linux")]
#[allow(dead_code)]
#[path = "../src/commands/identity.rs"]
mod identity;

#[cfg(target_os = "linux")]
fn main() -> Result<(), Box<dyn std::error::Error>> {
    use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
    use ed25519_dalek::{Signature, SigningKey};
    use serde::Serialize;
    use serde_json::json;
    use std::fs::{self, OpenOptions};
    use std::io::Write;
    use std::os::unix::fs::PermissionsExt;
    use std::path::PathBuf;

    let root = PathBuf::from(std::env::var("STUDYVIS_UPDATE_SMOKE_ROOT")?).canonicalize()?;
    let token = std::env::var("STUDYVIS_UPDATE_SMOKE_TOKEN")?;
    if token.len() < 32
        || fs::read_to_string(root.join(".owned-update-smoke"))? != token
        || fs::metadata(&root)?.permissions().mode() & 0o077 != 0
    {
        return Err("requires a private owned update-smoke directory".into());
    }
    for (variable, directory) in [
        ("XDG_DATA_HOME", "data"),
        ("XDG_CONFIG_HOME", "config"),
        ("XDG_CACHE_HOME", "cache"),
        ("XDG_RUNTIME_DIR", "runtime"),
    ] {
        if PathBuf::from(std::env::var(variable)?).canonicalize()? != root.join(directory) {
            return Err(
                format!("{variable} must stay inside the owned update-smoke directory").into(),
            );
        }
    }
    if std::env::var("DBUS_SESSION_BUS_ADDRESS")?
        != format!("unix:path={}", root.join("bus").display())
    {
        return Err("refusing to use a nonprivate credential-store bus".into());
    }
    let mode = std::env::args()
        .nth(1)
        .ok_or("seed or verify is required")?;
    if mode != "seed" && mode != "verify" {
        return Err("seed or verify is required".into());
    }
    let own_signing = SigningKey::from_bytes(&[1; 32]);
    let own_ed = hex::encode(own_signing.verifying_key().to_bytes());
    let own_box = crypto_box::SecretKey::from([2; 32]);
    let own_x = hex::encode(own_box.public_key().as_bytes());
    let friend_signing = SigningKey::from_bytes(&[7; 32]);
    let friend_box = crypto_box::SecretKey::from([8; 32]);
    let path = root.join("data/studyvis/identity.json");
    if mode == "seed" {
        if path.exists() || identity::identity_keys_present()? {
            return Err("refusing existing identity in the private test provider".into());
        }
        identity::identity_save_keys(hex::encode([1; 32]), hex::encode([2; 32]), false)?;
        let record = identity::IdentityRecord {
            version: 1,
            ed_pubkey_hex: own_ed.clone(),
            x_pubkey_hex: own_x.clone(),
            display_name: "Disposable update identity".into(),
            created_at: 1_700_000_000_000,
            mnemonic_fingerprint: "synthetic-update-fixture".into(),
        };
        fs::create_dir_all(path.parent().ok_or("identity parent missing")?)?;
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)?;
        file.write_all(&serde_json::to_vec_pretty(&record)?)?;
    }
    let record: identity::IdentityRecord = serde_json::from_slice(&fs::read(&path)?)?;
    if record.ed_pubkey_hex != own_ed || record.x_pubkey_hex != own_x {
        return Err("public identity changed across the update".into());
    }
    let challenge = b"StudyVis isolated N-1 key-custody preservation";
    let proof = identity::identity_sign(challenge.to_vec())?;
    own_signing
        .verifying_key()
        .verify_strict(challenge, &Signature::from_slice(&proof)?)?;
    let nonce = [9; crypto::NONCE_LEN];
    let encrypted = crypto::nacl_box_encrypt(
        own_box.public_key().as_bytes(),
        &friend_box.to_bytes(),
        &nonce,
        challenge,
    )?;
    let decrypted = identity::identity_box_decrypt(
        hex::encode(friend_box.public_key().as_bytes()),
        BASE64.encode(nonce),
        BASE64.encode(encrypted),
    )?;
    if decrypted != challenge {
        return Err("stored X25519 key did not survive the update".into());
    }
    // Field order is the shipped serializeAuditForSig contract. Only public,
    // deterministic synthetic material leaves the private provider.
    #[derive(Serialize)]
    struct AuditCore<'a> {
        v: u8,
        session_topic: &'a str,
        ts: i64,
        who: &'a str,
        kind: &'a str,
        detail: serde_json::Value,
    }
    let topic = "11".repeat(32);
    let core = AuditCore {
        v: 1,
        session_topic: &topic,
        ts: 1_700_000_000_000,
        who: &own_ed,
        kind: "topic_set",
        detail: json!({"topic": "Algebra updater preservation"}),
    };
    let signature = identity::identity_sign(serde_json::to_vec(&core)?)?;
    own_signing.verifying_key().verify_strict(
        &serde_json::to_vec(&core)?,
        &Signature::from_slice(&signature)?,
    )?;
    println!(
        "{}",
        json!({
            "mode": mode,
            "identity": record,
            "friend": {
                "ed": hex::encode(friend_signing.verifying_key().to_bytes()),
                "x": hex::encode(friend_box.public_key().as_bytes()),
                "name": "Updater fixture friend"
            },
            "audit": {"core": core, "sig": hex::encode(signature)},
            "signingKeyPreserved": true,
            "encryptionKeyPreserved": true
        })
    );
    Ok(())
}

#[cfg(not(target_os = "linux"))]
fn main() {
    panic!("The update fixture requires an isolated Linux Secret Service session");
}
