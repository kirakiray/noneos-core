/**
 * Peer E2EE（Stage 5）
 *
 * 直接用身份 ECDSA P-256 密钥做 ECDH 派生共享密钥，再用 AES-256-GCM
 * 加密 PeerSession payload。密文格式：[iv(12B)][ciphertext+tag]。
 *
 * 注意：ECDSA 私钥/公钥在 WebCrypto 中可复用为 ECDH（同曲线），
 * 两端必须使用同一个远程公钥；userId 由公钥哈希确定，因此无需额外信任链。
 */
const keyCache = new Map();

const fromBase64 = (value) =>
  Uint8Array.from(atob(value), (char) => char.charCodeAt(0));

const importEcdhPrivate = (privateKeyBase64) =>
  crypto.subtle.importKey(
    "pkcs8",
    fromBase64(privateKeyBase64),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"],
  );

const importEcdhPublic = (publicKeyBase64) =>
  crypto.subtle.importKey(
    "spki",
    fromBase64(publicKeyBase64),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );

export const deriveSharedKey = async (localIdentity, remotePublicKey) => {
  if (!localIdentity?.privateKey || !remotePublicKey) {
    throw new TypeError("deriveSharedKey requires local identity and remote publicKey");
  }
  const cacheKey = `${localIdentity.userId}:${remotePublicKey}`;
  if (keyCache.has(cacheKey)) return keyCache.get(cacheKey);

  const privateKey = await importEcdhPrivate(localIdentity.privateKey);
  const publicKey = await importEcdhPublic(remotePublicKey);
  const bits = await crypto.subtle.deriveBits(
    { name: "ECDH", public: publicKey },
    privateKey,
    256,
  );
  const aesKey = await crypto.subtle.importKey(
    "raw",
    bits,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
  keyCache.set(cacheKey, aesKey);
  return aesKey;
};

export const encryptBytes = async (aesKey, bytes) => {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    aesKey,
    bytes,
  );
  const out = new Uint8Array(12 + ciphertext.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(ciphertext), 12);
  return out;
};

export const decryptBytes = async (aesKey, payload) => {
  if (!(payload instanceof Uint8Array) || payload.byteLength <= 12) {
    throw new Error("invalid ciphertext");
  }
  const iv = payload.subarray(0, 12);
  const ciphertext = payload.subarray(12);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    aesKey,
    ciphertext,
  );
  return new Uint8Array(plain);
};

/**
 * 创建 PeerSession 的 payload codec（可选传给 hub）。
 */
export const createCodec = async ({ localIdentity, remotePublicKey }) => {
  const key = await deriveSharedKey(localIdentity, remotePublicKey);
  return {
    async encode(bytes) {
      return encryptBytes(key, bytes);
    },
    async decode(payload) {
      return decryptBytes(key, payload);
    },
  };
};
