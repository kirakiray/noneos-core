/**
 * 身份持久化（Stage 5）
 *
 * 身份与私钥保存在 nos/storage 的独立空间；SharedWorker 首次启动时
 * 读取或生成，标签页不需要接触私钥。
 */
import { getStorage } from "../storage/main.js";
import {
  createIdentity,
  identityFromKeys,
  identityToJSON,
} from "./identity.js";

const STORAGE_ID = "nos-peer-identity";
const IDENTITY_KEY = "identity";
const store = getStorage(STORAGE_ID);

export const loadIdentity = async () => {
  const saved = await store.getItem(IDENTITY_KEY);
  if (!saved?.publicKey || !saved?.privateKey) return null;
  return identityFromKeys(saved);
};

export const loadOrCreateIdentity = async () => {
  const existing = await loadIdentity();
  if (existing) return existing;
  const identity = await createIdentity();
  await store.setItem(IDENTITY_KEY, identityToJSON(identity));
  return identity;
};

export const saveIdentity = async (identity) => {
  await store.setItem(IDENTITY_KEY, identityToJSON(identity));
};

export const clearIdentity = async () => {
  await store.removeItem(IDENTITY_KEY);
};
