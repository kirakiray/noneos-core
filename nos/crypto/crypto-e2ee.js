/**
 * E2EE（端到端加密）模块
 *
 * 利用现有的 ECDSA P-256 密钥对，通过 ECDH 派生共享密钥，
 * 使用 AES-256-GCM 对消息负载进行加解密。
 *
 * 密文以纯二进制格式传输（无 base64），走 WebSocket 二进制帧通道。
 * 二进制载荷格式：[iv(12 字节)] + [AES-GCM 密文(含认证标签)]
 *
 * 共享密钥按 (localUserId, remoteUserId) 缓存，避免重复派生。
 */

const sharedKeyCache = new Map();

/**
 * 导入 PKCS8 私钥用于 ECDH
 */
function importPrivateKey(privateKeyBase64) {
  const binaryKey = Uint8Array.from(atob(privateKeyBase64), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey(
    "pkcs8", binaryKey,
    { name: "ECDH", namedCurve: "P-256" },
    false, ["deriveBits"]
  );
}

/**
 * 导入 SPKI 公钥用于 ECDH
 */
function importPublicKey(publicKeyBase64) {
  const binaryKey = Uint8Array.from(atob(publicKeyBase64), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey(
    "spki", binaryKey,
    { name: "ECDH", namedCurve: "P-256" },
    false, []
  );
}

/**
 * ECDH 派生 AES-256-GCM 共享密钥
 */
async function deriveKey(localPrivateKey, remotePublicKey) {
  const privateKey = await importPrivateKey(localPrivateKey);
  const publicKey = await importPublicKey(remotePublicKey);

  const sharedBits = await crypto.subtle.deriveBits(
    { name: "ECDH", public: publicKey },
    privateKey, 256
  );

  return crypto.subtle.importKey(
    "raw", sharedBits,
    { name: "AES-GCM" },
    false, ["encrypt", "decrypt"]
  );
}

/**
 * 获取/缓存共享密钥
 */
async function getOrDeriveKey(localPrivateKey, remotePublicKey, localUserId, remoteUserId) {
  const [a, b] = [localUserId, remoteUserId].sort();
  const cacheKey = `${a}:${b}`;

  if (sharedKeyCache.has(cacheKey)) {
    return sharedKeyCache.get(cacheKey);
  }

  const key = await deriveKey(localPrivateKey, remotePublicKey);
  sharedKeyCache.set(cacheKey, key);
  return key;
}

/**
 * 加密数据为二进制载荷
 *
 * 将 JSON 可序列化的 data 加密为 [iv(12B)][ciphertext] 的 Uint8Array。
 * AES-GCM 的认证标签自动附加在 ciphertext 末尾。
 *
 * @param {*} data - JSON 可序列化数据
 * @param {CryptoKey} aesKey - AES-GCM 密钥
 * @returns {Promise<Uint8Array>} [iv(12B) + ciphertext]
 */
async function encrypt(data, aesKey) {
  const plainBytes = new TextEncoder().encode(JSON.stringify(data));
  const iv = crypto.getRandomValues(new Uint8Array(12));

  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv }, aesKey, plainBytes
  );

  const result = new Uint8Array(12 + ciphertext.byteLength);
  result.set(iv, 0);
  result.set(new Uint8Array(ciphertext), 12);
  return result;
}

/**
 * 解密二进制载荷
 *
 * 输入 [iv(12B)][ciphertext]，输出原始 JSON 数据。
 * AES-GCM 认证失败时会抛出异常。
 *
 * @param {Uint8Array} payload - [iv(12B) + ciphertext]
 * @param {CryptoKey} aesKey - AES-GCM 密钥
 * @returns {Promise<*>} 原始数据
 */
async function decrypt(payload, aesKey) {
  const iv = payload.slice(0, 12);
  const ciphertext = payload.slice(12);

  const plainBytes = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv }, aesKey, ciphertext
  );

  return JSON.parse(new TextDecoder().decode(plainBytes));
}

/**
 * 尝试加密消息数据为二进制载荷
 *
 * 在 RemoteUser.send() 中调用。
 * 仅在本地已有对方资料（公钥）时加密，否则返回 null 走明文路径。
 *
 * @param {Object} localUser - LocalUser 实例
 * @param {string} remoteUserId - 目标用户 ID
 * @param {*} data - 要加密的 JSON 可序列化数据
 * @returns {Promise<Uint8Array|null>} [iv(12B)+ciphertext] 或 null
 */
export async function tryEncryptBinary(localUser, remoteUserId, data) {
  const privateKey = localUser._getPrivateKey();
  if (!privateKey) return null;

  const remoteProfile = await localUser.cred.getProfileByDB(remoteUserId);
  if (!remoteProfile || !remoteProfile.publicKey) return null;

  try {
    const aesKey = await getOrDeriveKey(
      privateKey, remoteProfile.publicKey,
      localUser.userId, remoteUserId
    );
    return encrypt(data, aesKey);
  } catch (err) {
    console.warn("[E2EE] Encryption failed:", err);
    return null;
  }
}

/**
 * 尝试解密二进制载荷
 *
 * 在接收端的二进制 relay 帧处理中调用。
 * 如果解密失败（非 E2EE 数据或密钥不匹配），返回 null。
 *
 * @param {Object} localUser - LocalUser 实例
 * @param {string} fromUserId - 发送方用户 ID
 * @param {Uint8Array} payload - [iv(12B)+ciphertext]
 * @returns {Promise<*|null>} 解密后的原始数据，或 null
 */
export async function tryDecryptBinary(localUser, fromUserId, payload) {
  if (payload.byteLength <= 12) return null;

  const privateKey = localUser._getPrivateKey();
  if (!privateKey) return null;

  const remoteProfile = await localUser.cred.getProfileByDB(fromUserId);
  if (!remoteProfile || !remoteProfile.publicKey) return null;

  try {
    const aesKey = await getOrDeriveKey(
      privateKey, remoteProfile.publicKey,
      localUser.userId, fromUserId
    );
    return decrypt(payload, aesKey);
  } catch {
    // AES-GCM 认证失败 = 不是 E2EE 数据
    return null;
  }
}
