import { verifyData } from "../../nos/crypto/crypto-verify.js";
import { getStorage } from "../../nos/storage/main.js";
import { getHash } from "../../nos/util/hash/get-hash.js";

// 内置信任锚：受信根密钥公钥的 sha-256 指纹（hex），由 scripts/rotate-root.js 自动重写。
// 全新安装（本地无缓存的信任集）时，根证书的签名者必须命中此列表；
// 已有缓存时走链式信任，不依赖此列表。
// 生成指纹：node scripts/rotate-root.js pin-hash [id]
const PINNED_ROOT_KEY_HASHES = new Set([
  // root
  "ca9a5c850b32c1cff4c8a7f991ef447da4d80eedd2b91d0a86bb5152949438e7",
]);

/**
 * 校验吊销状态（域名信任根）。
 * root-status.json 由部署渠道（HTTPS + 域名控制权）保证真实性，不需要签名：
 * 它是主私钥泄漏后的保底机制——产权方通过域名发布吊销记录，客户端立即拒绝
 * 被吊销密钥参与的任何信任集，不与攻击者进行 generation 竞赛。
 * @param {Object} rootCert - 根证书信任集
 * @param {Object|null} rootStatus - 线上（或本地缓存的最后一份）吊销状态；null 表示从未获取到，跳过检查
 */
export const verifyRootStatus = async (rootCert, rootStatus) => {
  if (!rootStatus) {
    return true;
  }

  if (rootCert.generation < (rootStatus.minGeneration || 1)) {
    throw new Error("Root certificate generation has been revoked");
  }

  const keyHashes = await Promise.all(
    rootCert.keys.map((key) => getHash(key.publicKey))
  );

  for (const revokedHash of rootStatus.revokedKeyHashes || []) {
    if (keyHashes.includes(revokedHash)) {
      throw new Error("Revoked root key is present in the trust set");
    }
  }

  return true;
};

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

  // 指纹表（供吊销比对与 pin 校验复用）
  const keyHashes = await Promise.all(
    rootCert.keys.map((key) => getHash(key.publicKey))
  );

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

    // 退役不可逆：曾在新缓存信任集中退役的密钥，不得在后续信任集中复活
    for (const oldKey of cachedCert.keys) {
      if (oldKey.status !== "retired") {
        continue;
      }

      const revived = rootCert.keys.find(
        (key) =>
          key.publicKey === oldKey.publicKey && key.status !== "retired"
      );

      if (revived) {
        throw new Error("Retired key cannot be re-activated");
      }
    }
  } else {
    const signerHash = keyHashes[rootCert.keys.indexOf(signerEntry)];

    if (!PINNED_ROOT_KEY_HASHES.has(signerHash)) {
      throw new Error("Root certificate signer is not pinned");
    }
  }

  return true;
};

export const getOnlineData = async () => {
  // 吊销状态（域名信任根）：拉取失败时降级用本地缓存的最后一份；从未获取到则跳过检查
  let rootStatus = null;

  try {
    rootStatus = await fetch(
      new URL("../../nos/root-status.json", import.meta.url).href,
      {
        cache: "no-store",
      }
    ).then((e) => e.json());

    await trustStore.setItem("last-root-status", rootStatus);
  } catch {
    rootStatus = await trustStore.getItem("last-root-status");
  }

  const rootCert = await fetch(
    new URL("../../nos/root-cert.json", import.meta.url).href,
    {
      cache: "no-store",
    }
  ).then((e) => e.json());

  const cachedCert = await trustStore.getItem(CACHED_CERT_KEY);

  await verifyRootStatus(rootCert, rootStatus);
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
