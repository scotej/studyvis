use crypto_box::{
    aead::Aead, PublicKey as BoxPublicKey, SalsaBox, SecretKey as BoxSecretKey,
};

pub const X_KEY_LEN: usize = 32;
pub const NONCE_LEN: usize = 24;

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
