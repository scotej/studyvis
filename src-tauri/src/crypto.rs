//! NaCl `crypto_box` (X25519 + XSalsa20-Poly1305) helpers shared by the
//! identity and friends-backup commands.
//!
//! Wire-format contract: output must stay byte-compatible with libsodium's
//! `crypto_box_easy` and with the JS side (`src/lib/crypto/identity.ts`), which
//! seals invite envelopes this module opens. A shared libsodium test vector is
//! pinned in `tests/box_decrypt_vector.rs` and mirrored in
//! `tests/unit/identity.test.ts` — if either fails, invites break on the wire.

use crypto_box::{aead::Aead, PublicKey as BoxPublicKey, SalsaBox, SecretKey as BoxSecretKey};

pub const X_KEY_LEN: usize = 32;
pub const NONCE_LEN: usize = 24;

/// Opens a `crypto_box_easy`-compatible box from `their_x_pub` addressed to
/// `my_x_priv`. Errors are deliberately unspecific ("decrypt failed") so a
/// caller can't leak why an envelope was rejected.
pub fn nacl_box_decrypt(
    their_x_pub: &[u8; X_KEY_LEN],
    my_x_priv: &[u8; X_KEY_LEN],
    nonce: &[u8; NONCE_LEN],
    ciphertext: &[u8],
) -> Result<Vec<u8>, String> {
    let secret = BoxSecretKey::from(*my_x_priv);
    let public = BoxPublicKey::from(*their_x_pub);
    let salsa_box = SalsaBox::new(&public, &secret);
    salsa_box
        .decrypt(crypto_box::Nonce::from_slice(nonce), ciphertext)
        .map_err(|_| "decrypt failed".to_string())
}

/// Seals a `crypto_box_easy`-compatible box for `their_x_pub`. The nonce is
/// caller-supplied (24 random bytes per message) and travels alongside the
/// ciphertext unencrypted, per NaCl convention.
pub fn nacl_box_encrypt(
    their_x_pub: &[u8; X_KEY_LEN],
    my_x_priv: &[u8; X_KEY_LEN],
    nonce: &[u8; NONCE_LEN],
    plaintext: &[u8],
) -> Result<Vec<u8>, String> {
    let secret = BoxSecretKey::from(*my_x_priv);
    let public = BoxPublicKey::from(*their_x_pub);
    let salsa_box = SalsaBox::new(&public, &secret);
    salsa_box
        .encrypt(crypto_box::Nonce::from_slice(nonce), plaintext)
        .map_err(|_| "encrypt failed".to_string())
}
