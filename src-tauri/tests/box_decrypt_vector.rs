// libsodium NaCl-box-easy compatibility vector. Generated with pynacl
// (libsodium binding) using RFC 7748 §6.1 X25519 reference scalars.
// The same vector is asserted on the JS side in tests/unit/identity.test.ts —
// any drift between the two implementations breaks invite envelopes on the wire.

use studyvis_lib::crypto::nacl_box_decrypt;

const ALICE_X_PUB_HEX: &str = "8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a";
const BOB_X_PRIV_HEX: &str = "5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb";
const NONCE_HEX: &str = "69696ee955b62b73cd62bda875fc73d68219e0036b7a0b37";
const CIPHERTEXT_HEX: &str =
    "7e5c50f10331000e8b4f7019d8eb46f443ea113e0d9f89d520eb2ddab0631f986c7e88f9355d";
const EXPECTED_PLAINTEXT: &[u8] = b"studyvis-invite-vector";

fn decode32(s: &str) -> [u8; 32] {
    let v = hex::decode(s).expect("hex decode");
    v.try_into().expect("32 bytes")
}

fn decode24(s: &str) -> [u8; 24] {
    let v = hex::decode(s).expect("hex decode");
    v.try_into().expect("24 bytes")
}

#[test]
fn decrypts_libsodium_vector_byte_for_byte() {
    let alice_pub = decode32(ALICE_X_PUB_HEX);
    let bob_priv = decode32(BOB_X_PRIV_HEX);
    let nonce = decode24(NONCE_HEX);
    let ciphertext = hex::decode(CIPHERTEXT_HEX).expect("ct hex");

    let plaintext = nacl_box_decrypt(&alice_pub, &bob_priv, &nonce, &ciphertext)
        .expect("decrypt should succeed");

    assert_eq!(plaintext, EXPECTED_PLAINTEXT);
}

#[test]
fn rejects_tampered_ciphertext() {
    let alice_pub = decode32(ALICE_X_PUB_HEX);
    let bob_priv = decode32(BOB_X_PRIV_HEX);
    let nonce = decode24(NONCE_HEX);
    let mut ciphertext = hex::decode(CIPHERTEXT_HEX).expect("ct hex");
    let last = ciphertext.len() - 1;
    ciphertext[last] ^= 0x01;

    assert!(nacl_box_decrypt(&alice_pub, &bob_priv, &nonce, &ciphertext).is_err());
}

#[test]
fn rejects_tampered_nonce() {
    let alice_pub = decode32(ALICE_X_PUB_HEX);
    let bob_priv = decode32(BOB_X_PRIV_HEX);
    let mut nonce = decode24(NONCE_HEX);
    nonce[0] ^= 0x01;
    let ciphertext = hex::decode(CIPHERTEXT_HEX).expect("ct hex");

    assert!(nacl_box_decrypt(&alice_pub, &bob_priv, &nonce, &ciphertext).is_err());
}

#[test]
fn rejects_wrong_sender_pub() {
    // Use bob's own public key (instead of alice's) as the "sender" — a
    // stranger who substitutes a different sender key should fail to decrypt.
    let bob_pub = decode32("de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f");
    let bob_priv = decode32(BOB_X_PRIV_HEX);
    let nonce = decode24(NONCE_HEX);
    let ciphertext = hex::decode(CIPHERTEXT_HEX).expect("ct hex");

    assert!(nacl_box_decrypt(&bob_pub, &bob_priv, &nonce, &ciphertext).is_err());
}
