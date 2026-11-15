//! Stage 5：ECDSA P-256 挑战应答。
//!
//! 服务端在 WS 建立后发送随机 challenge；客户端用私钥签名并提交
//! userId/publicKey/signature；服务端校验 userId 与签名后才注册连接。

use base64::{engine::general_purpose, Engine as _};
use p256::ecdsa::{signature::Verifier, Signature, VerifyingKey};
use p256::pkcs8::DecodePublicKey;
use rand::RngCore;
use serde::Deserialize;
use sha2::{Digest, Sha256};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthRequest {
    #[serde(rename = "type")]
    pub kind: String,
    pub user_id: String,
    pub public_key: String,
    pub signature: String,
}

#[derive(Debug, Clone)]
pub struct AuthInfo {
    pub user_id: String,
    pub public_key: String,
}

pub fn new_challenge() -> String {
    let mut bytes = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    to_hex(&bytes)
}

pub fn user_id_for_public_key(public_key_b64: &str) -> String {
    let digest = Sha256::digest(public_key_b64.as_bytes());
    to_hex(&digest)
}

pub fn verify_auth(request: &AuthRequest, challenge: &str) -> Result<AuthInfo, String> {
    if request.kind != "auth" {
        return Err("unexpected message type".to_string());
    }
    if request.user_id.is_empty() || request.public_key.is_empty() {
        return Err("missing identity fields".to_string());
    }
    let expected = user_id_for_public_key(&request.public_key);
    if expected != request.user_id {
        return Err("userId does not match publicKey".to_string());
    }

    let public_key_der = general_purpose::STANDARD
        .decode(&request.public_key)
        .map_err(|err| format!("invalid publicKey: {err}"))?;
    let verifying_key = VerifyingKey::from_public_key_der(&public_key_der)
        .map_err(|err| format!("invalid publicKey SPKI: {err}"))?;

    let signature_bytes = general_purpose::STANDARD
        .decode(&request.signature)
        .map_err(|err| format!("invalid signature: {err}"))?;
    let signature = Signature::from_slice(&signature_bytes)
        .map_err(|err| format!("invalid signature bytes: {err}"))?;

    verifying_key
        .verify(challenge.as_bytes(), &signature)
        .map_err(|err| format!("signature verification failed: {err}"))?;

    Ok(AuthInfo {
        user_id: request.user_id.clone(),
        public_key: request.public_key.clone(),
    })
}

fn to_hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        use std::fmt::Write;
        let _ = write!(out, "{byte:02x}");
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use p256::ecdsa::{signature::Signer, SigningKey};
    use p256::pkcs8::EncodePublicKey;

    fn identity() -> (SigningKey, String, String) {
        let signing = SigningKey::random(&mut rand::rngs::OsRng);
        let der = signing.verifying_key().to_public_key_der().unwrap();
        let public_key = general_purpose::STANDARD.encode(der.as_bytes());
        let user_id = user_id_for_public_key(&public_key);
        (signing, public_key, user_id)
    }

    #[test]
    fn verifies_valid_auth() {
        let (signing, public_key, user_id) = identity();
        let challenge = new_challenge();
        let signature: Signature = signing.sign(challenge.as_bytes());
        let request = AuthRequest {
            kind: "auth".to_string(),
            user_id,
            public_key,
            signature: general_purpose::STANDARD.encode(signature.to_bytes()),
        };
        let info = verify_auth(&request, &challenge).unwrap();
        assert_eq!(info.user_id, request.user_id);
    }

    #[test]
    fn rejects_wrong_user_id_and_bad_signature() {
        let (signing, public_key, user_id) = identity();
        let challenge = new_challenge();
        let signature: Signature = signing.sign(challenge.as_bytes());

        let mut request = AuthRequest {
            kind: "auth".to_string(),
            user_id: user_id.clone(),
            public_key: public_key.clone(),
            signature: general_purpose::STANDARD.encode(signature.to_bytes()),
        };
        request.user_id = "deadbeef".to_string();
        assert!(verify_auth(&request, &challenge).is_err());

        let mut request = AuthRequest {
            kind: "auth".to_string(),
            user_id,
            public_key,
            signature: general_purpose::STANDARD.encode(signature.to_bytes()),
        };
        request.signature = general_purpose::STANDARD.encode([0u8; 64]);
        assert!(verify_auth(&request, &challenge).is_err());
    }
}
