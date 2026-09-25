import { verifyData } from "../../nos/crypto/crypto-verify.js";
import { getStorage } from "../../nos/storage/main.js";
import { getHash } from "../../nos/util/hash/get-hash.js";

// 内置信任锚：受信根密钥公钥的 sha-256 指纹（hex）。
// 全新安装（本地无缓存的信任集）时，根证书的签名者必须命中此列表。
// 常规轮换由旧信任集链式信任完成，无需更新此列表；
// 泄漏应急轮换时，用备用密钥签发新信任集，并将其指纹追加到此处随客户端发版。
// 生成指纹：node scripts/rotate-root.js pin-hash [id]
const PINNED_ROOT_KEY_HASHES = new Set([
  // 根密钥 rootkeys/root.json
  "ca9a5c850b32c1cff4c8a7f991ef447da4d80eedd2b91d0a86bb5152949438e7",
  // 备用密钥指纹（应急轮换用，生成后填入）
]);

// 本地缓存的已受信信任集，用于链式校验与 generation 防回滚
const trustStore = getStorage("nos-root-trust");
const CACHED_CERT_KEY = "cached-root-cert";

const isValidStatus = (status) =>
  ["active", "grace", "retired"].includes(status);

const assertTrustSetStructure = (rootCert) => {
  if (
    rootCert.type !== "root" ||
    !Number.isInteger(rootCert.generation) ||
    rootCert.generation < 1 ||
    !Array.isArray(rootCert.keys) ||
    rootCert.keys.length === 0 ||
    typeof rootCert.publicKey !== "string"
  ) {
    throw new Error("Invalid root certificate structure");
  }

  const ids = new Set();
  for (const key of rootCert.keys) {
    if (
      typeof key.id !== "string" ||
      typeof key.publicKey !== "string" ||
      !isValidStatus(key.status) ||
      ids.has(key.id)
    ) {
      throw new Error("Invalid key entry in root certificate");
    }
    ids.add(key.id);
  }
};

/**
 * 校验根证书信任集。
 * 签名必须由信任集中 active/grace 的密钥签发，且满足以下信任链之一：
 * - 全新安装（无本地缓存）：签名者指纹命中内置 pin；
 * - 已有本地缓存：签名者属于上一份受信信任集中的有效密钥，且 generation 未回滚。
 * @param {Object} rootCert - 线上下发的根证书信任集
 * @param {Object} [cachedCert] - 本地缓存的上一份受信信任集
 */
export const verifyRootCert = async (rootCert, cachedCert) => {
  assertTrustSetStructure(rootCert);

  if (!(await verifyData(rootCert))) {
    throw new Error("Root certificate verification failed");
  }

  const signerEntry = rootCert.keys.find(
    (key) => key.publicKey === rootCert.publicKey
  );

  if (!signerEntry || signerEntry.status === "retired") {
    throw new Error("Root certificate signer is not a valid trust set member");
  }

  if (cachedCert && Array.isArray(cachedCert.keys)) {
    if (rootCert.generation < cachedCert.generation) {
      throw new Error("Root certificate generation rollback detected");
    }

    const trustedKeys = cachedCert.keys
      .filter((key) => key.status !== "retired")
      .map((key) => key.publicKey);

    if (!trustedKeys.includes(rootCert.publicKey)) {
      throw new Error(
        "Root certificate signer is not trusted by the cached trust set"
      );
    }
  } else {
    const signerHash = await getHash(rootCert.publicKey);

    if (!PINNED_ROOT_KEY_HASHES.has(signerHash)) {
      throw new Error("Root certificate signer is not pinned");
    }
  }

  return true;
};

export const getOnlineData = async () => {
  const rootCert = await fetch(
    new URL("../../nos/root-cert.json", import.meta.url).href,
    {
      cache: "no-store",
    }
  ).then((e) => e.json());

  const cachedCert = await trustStore.getItem(CACHED_CERT_KEY);

  await verifyRootCert(rootCert, cachedCert);

  // 缓存通过校验的信任集，作为下次更新的链式信任依据
  await trustStore.setItem(CACHED_CERT_KEY, rootCert);

  const onlineNosConfig = await fetch(
    new URL("../../nos.json", import.meta.url).href,
    {
      cache: "no-store",
    }
  ).then((res) => res.json());

  const isNosConfigValid = await verifyData(onlineNosConfig);

  if (!isNosConfigValid) {
    throw new Error("nos.json verification failed");
  }

  // nos.json 必须由信任集中 active 状态的密钥签发
  const activeKeys = rootCert.keys
    .filter((key) => key.status === "active")
    .map((key) => key.publicKey);

  if (!activeKeys.includes(onlineNosConfig.publicKey)) {
    throw new Error("nos.json is not signed by an active root key");
  }

  return {
    rootCert,
    onlineNosConfig,
  };
};

// 注册 Service Worker
export const registerSw = async (name) => {
  if (!navigator.serviceWorker) {
    throw new Error("Service Worker is not supported");
  }

  const registration = await navigator.serviceWorker.register("/" + name);

  await navigator.serviceWorker.ready;

  if (registration.active?.state === "activated") {
    return registration;
  }

  const activeWorker = registration.active || registration.installing;

  return new Promise((resolve, reject) => {
    if (!activeWorker) {
      reject(new Error("No active Service Worker found"));
      return;
    }

    const handleStateChange = () => {
      if (activeWorker.state === "activated") {
        console.log("Service Worker activated:", registration.scope);
        resolve(registration);
      }
    };

    activeWorker.addEventListener("statechange", handleStateChange);

    if (activeWorker.state === "activated") {
      handleStateChange();
    }
  });
};

export const clearSw = async () => {
  const registrations = await navigator.serviceWorker.getRegistrations();

  await Promise.all(
    registrations.map(async (registration) => {
      const success = await registration.unregister();
      if (success) {
        console.log("Service Worker unregistered:", registration.scope);
      }
    }),
  );
};
