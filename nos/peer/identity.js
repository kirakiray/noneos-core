/**
 * Peer 身份（Stage 5）
 *
 * - ECDSA P-256（WebCrypto）
 * - userId = SHA-256(publicKey base64) 的 hex，与旧系统的身份约定一致
 */
import { generateKeyPair, createSigner, createVerifier } from "../crypto/crypto-ecdsa.js";
import { getHash } from "../util/hash/get-hash.js";

const toBase64 = (buffer) =>
  btoa(String.fromCharCode(...new Uint8Array(buffer)));

const fromBase64 = (value) =>
  Uint8Array.from(atob(value), (char) => char.charCodeAt(0));

export const createIdentity = async () => {
  const pair = await generateKeyPair();
  return identityFromKeys(pair);
};

export const identityFromKeys = async ({ publicKey, privateKey }) => {
  if (!publicKey || !privateKey) {
    throw new TypeError("identity requires publicKey and privateKey");
  }
  const userId = await getHash(publicKey);
  let signerPromise = null;

  const identity = {
    userId,
    publicKey,
    privateKey,
    async sign(message) {
      signerPromise ??= createSigner(privateKey);
      const signer = await signerPromise;
      const signature = await signer(String(message));
      return toBase64(signature);
    },
  };
  return identity;
};

export const verifySignature = async (publicKey, message, signatureBase64) => {
  const verify = await createVerifier(publicKey);
  return verify(String(message), fromBase64(signatureBase64).buffer);
};

export const identityToJSON = (identity) => ({
  userId: identity.userId,
  publicKey: identity.publicKey,
  privateKey: identity.privateKey,
});

export const identityFromJSON = (json) => {
  if (!json?.publicKey || !json?.privateKey) {
    throw new TypeError("invalid identity JSON");
  }
  return identityFromKeys(json);
};
