use p256::ecdsa::{VerifyingKey, Signature, signature::Verifier};
use p256::pkcs8::DecodePublicKey;
use base64::{engine::general_purpose, Engine};

/// 验证 ECDSA 签名（P-256 + SHA-256）
/// public_key_b64: 浏览器 Web Crypto exportKey("spki") 的 base64
/// message: 排序后的 JSON 字符串
/// signature_b64: 64 字节 R||S 的 base64
pub fn verify_signature(
    public_key_b64: &str,
    message: &str,
    signature_b64: &str,
) -> Result<(), String> {
    let public_key_der = general_purpose::STANDARD
        .decode(public_key_b64)
        .map_err(|e| format!("Failed to decode public key base64: {}", e))?;

    let verifying_key = VerifyingKey::from_public_key_der(&public_key_der)
        .map_err(|e| format!("Failed to parse public key SPKI: {}", e))?;

    let signature_bytes = general_purpose::STANDARD
        .decode(signature_b64)
        .map_err(|e| format!("Failed to decode signature base64: {}", e))?;

    let signature = Signature::from_slice(&signature_bytes)
        .map_err(|e| format!("Failed to parse signature: {}", e))?;

    verifying_key
        .verify(message.as_bytes(), &signature)
        .map_err(|e| format!("Signature verification failed: {}", e))?;

    Ok(())
}
