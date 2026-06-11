use p256::ecdsa::{VerifyingKey, Signature, signature::Verifier};
use p256::pkcs8::DecodePublicKey;
use base64::{engine::general_purpose, Engine as _};

/// 验证 ECDSA 签名
/// 
/// # 参数
/// * `public_key_b64` - Base64 编码的公钥 (SPKI 格式)
/// * `message` - 原始消息内容
/// * `signature_b64` - Base64 编码的签名 (原始 R|S 字节)
pub fn verify_signature(public_key_b64: &str, message: &str, signature_b64: &str) -> Result<(), String> {
    // 1. 解码公钥 (SPKI 格式)
    let public_key_der = general_purpose::STANDARD
        .decode(public_key_b64)
        .map_err(|e| format!("Failed to decode public key base64: {}", e))?;
    
    let verifying_key = VerifyingKey::from_public_key_der(&public_key_der)
        .map_err(|e| format!("Failed to parse public key SPKI: {}", e))?;

    // 2. 解码签名 (Web Crypto 对于 ECDSA 返回原始 R|S 字节)
    let signature_bytes = general_purpose::STANDARD
        .decode(signature_b64)
        .map_err(|e| format!("Failed to decode signature base64: {}", e))?;
    
    let signature = Signature::from_slice(&signature_bytes)
        .map_err(|e| format!("Failed to parse signature: {}", e))?;

    // 3. 验证签名
    verifying_key.verify(message.as_bytes(), &signature)
        .map_err(|e| format!("Signature verification failed: {}", e))?;

    Ok(())
}
