/**
 * AES 加密相关工具函数
 */

/**
 * 从密码派生密钥
 * @param {string} password - 用户密码
 * @param {Uint8Array} salt - 盐值
 * @returns {Promise<CryptoKey>} 派生的密钥
 */
async function deriveKey(password, salt) {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveKey"]
  );

  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: salt,
      iterations: 100000,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"]
  );
}

/**
 * 使用密码加密数据
 * @param {string} password - 加密密码
 * @param {string} data - 要加密的数据（JSON 字符串）
 * @returns {Promise<string>} 加密后的数据（base64 格式）
 */
export async function encryptWithPassword(password, data) {
  const encoder = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  
  const key = await deriveKey(password, salt);
  
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv },
    key,
    encoder.encode(data)
  );

  // 将 salt + iv + encrypted 合并
  const combined = new Uint8Array(salt.length + iv.length + encrypted.byteLength);
  combined.set(salt, 0);
  combined.set(iv, salt.length);
  combined.set(new Uint8Array(encrypted), salt.length + iv.length);

  return btoa(String.fromCharCode(...combined));
}

/**
 * 使用密码解密数据
 * @param {string} password - 解密密码
 * @param {string} encryptedData - 加密的数据（base64 格式）
 * @returns {Promise<string>} 解密后的原始数据
 */
export async function decryptWithPassword(password, encryptedData) {
  const combined = Uint8Array.from(atob(encryptedData), (c) => c.charCodeAt(0));
  
  const salt = combined.slice(0, 16);
  const iv = combined.slice(16, 28);
  const encrypted = combined.slice(28);

  const key = await deriveKey(password, salt);

  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: iv },
    key,
    encrypted
  );

  return new TextDecoder().decode(decrypted);
}
