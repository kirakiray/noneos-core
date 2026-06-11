use p256::ecdsa::{VerifyingKey, Signature, signature::Verifier};
use p256::pkcs8::DecodePublicKey;
use base64::{engine::general_purpose, Engine as _};

/// 验证 ECDSA 签名（使用 P-256 曲线和 SHA-256 哈希算法）
/// 该函数主要用于校验来自客户端（浏览器 Web Crypto API）发送的用户信息签名
/// 
/// # 参数说明
/// * `public_key_b64` - Base64 编码的公钥。
///   浏览器端通过 `crypto.subtle.exportKey("spki", ...)` 导出，是标准的 SPKI 格式。
/// * `message` - 待验证的原始消息字符串。
///   在本项目中，它是排过序的用户信息 JSON 字符串。
/// * `signature_b64` - Base64 编码的签名数据。
///   Web Crypto 产生的 ECDSA 签名是原始的 R 和 S 字节对拼接（64字节）。
///
/// # 返回值
/// * `Ok(())` - 签名验证通过，数据完整且来源可靠。
/// * `Err(String)` - 验证失败，包含具体的错误原因。
pub fn verify_signature(public_key_b64: &str, message: &str, signature_b64: &str) -> Result<(), String> {
    // 1. 解码公钥：将 Base64 字符串还原为 DER 编码的字节数组
    let public_key_der = general_purpose::STANDARD
        .decode(public_key_b64)
        .map_err(|e| format!("Failed to decode public key base64: {}", e))?;
    
    // 2. 解析公钥：使用 p256 库从 SPKI/DER 格式中加载验证密钥（VerifyingKey）
    let verifying_key = VerifyingKey::from_public_key_der(&public_key_der)
        .map_err(|e| format!("Failed to parse public key SPKI: {}", e))?;

    // 3. 解码签名：将 Base64 字符串还原为原始签名字节
    let signature_bytes = general_purpose::STANDARD
        .decode(signature_b64)
        .map_err(|e| format!("Failed to decode signature base64: {}", e))?;
    
    // 4. 解析签名：将 64 字节的原始数据解析为 ECDSA 签名对象（包含 R 和 S 分量）
    let signature = Signature::from_slice(&signature_bytes)
        .map_err(|e| format!("Failed to parse signature: {}", e))?;

    // 5. 执行验证：使用公钥对消息字节流进行签名比对
    // 内部会先对消息计算 SHA-256 哈希，然后执行非对称加密验证逻辑
    verifying_key.verify(message.as_bytes(), &signature)
        .map_err(|e| format!("Signature verification failed: {}", e))?;

    Ok(())
}
