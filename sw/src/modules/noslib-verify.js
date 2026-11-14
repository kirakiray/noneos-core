/**
 * nos-lib 签名清单校验。
 *
 * - 构建期由 scripts/calculate-noslib-hashes.js + scripts/sign-noslib-hashes.js
 *   生成并签发 nos-lib/nos-lib.json（整文件 SHA-256）。
 * - 运行时首次需要 nos-lib 文件时加载清单：先用内置 pin 校验签名者，再验签名；
 *   清单 version 必须单调递增（防回滚），升级版本时清空 nos-lib OPFS 缓存。
 * - 缓存命中不重复校验（写入前已校验）；缓存未命中才校验并落盘。
 * - localhost / 127.0.0.1 / [::1] 视为开发环境，跳过整套校验（与 dev 直连一致）。
 */
import { verifyData } from "../../../nos/crypto/crypto-verify.js";
import { getFileHandle, getRootDirectory } from "./file-system.js";

const MANIFEST_URL = "https://core.noneos.com/nos-lib/nos-lib.json";
const CACHE_DIR = "nos-lib";
const CACHED_MANIFEST_PATH = "nos-lib/.manifest.json";

// 构建期由 rollup.config.js 注入（根证书中 active + grace 的密钥公钥）
const PINNED_PUBLIC_KEYS = new Set(__NOSLIB_PINNED_KEYS__);

let manifestPromise = null;
let manifestLoadedAt = 0;

// 与文件 SWR 相同的 TTL：定期重新拉取清单，避免 SW 常驻时长期看不到 nos-lib 更新
const MANIFEST_TTL = 5 * 60 * 1000;

export const isLocalhostHost = (host = location.host) =>
  /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host);

const sha256Hex = async (blob) => {
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
};

const isTrustedManifest = async (manifest) => {
  if (!manifest || typeof manifest !== "object") return false;
  if (!PINNED_PUBLIC_KEYS.has(manifest.publicKey)) return false;
  if (!Array.isArray(manifest.hashes)) return false;
  try {
    return await verifyData(manifest);
  } catch {
    return false;
  }
};

const readCachedManifest = async () => {
  const handle = await getFileHandle({ path: CACHED_MANIFEST_PATH }).catch(
    () => null,
  );
  if (!handle) return null;
  const file = await handle.getFile();
  if (!file.size) return null;
  try {
    return JSON.parse(await file.text());
  } catch {
    return null;
  }
};

const writeCachedManifest = async (manifest) => {
  const handle = await getFileHandle({ path: CACHED_MANIFEST_PATH, create: true });
  const writable = await handle.createWritable();
  await writable.write(new Blob([JSON.stringify(manifest)]));
  await writable.close();
};

const purgeCacheDir = async () => {
  try {
    const root = await getRootDirectory();
    await root.removeEntry(CACHE_DIR, { recursive: true });
  } catch (err) {
    if (err?.name !== "NotFoundError") throw err;
  }
};

const fetchOnlineManifest = async () => {
  try {
    const response = await fetch(MANIFEST_URL, { cache: "no-store" });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return await response.json();
  } catch (err) {
    console.warn("[nos-lib] fetch manifest failed:", err);
    return null;
  }
};

const loadManifest = async () => {
  const cached = await readCachedManifest();
  const trustedCached = (await isTrustedManifest(cached)) ? cached : null;
  const online = await fetchOnlineManifest();

  if (online && (await isTrustedManifest(online))) {
    const onlineVersion = Number(online.version) || 0;
    const cachedVersion = Number(trustedCached?.version) || 0;

    if (onlineVersion < cachedVersion) {
      // 旧签名清单重放：拒绝降级，继续使用已缓存的较新清单
      console.warn(
        `[nos-lib] manifest rollback rejected: online=${onlineVersion} cached=${cachedVersion}`,
      );
      return trustedCached;
    }

    if (onlineVersion > cachedVersion) {
      // 新清单意味着文件可能已更新，清空旧缓存避免命中未校验的旧文件
      await purgeCacheDir();
      await writeCachedManifest(online);
    }

    return online;
  }

  return trustedCached;
};

export const getVerifiedManifest = () => {
  const expired = manifestLoadedAt && Date.now() - manifestLoadedAt >= MANIFEST_TTL;
  if (!manifestPromise || expired) {
    manifestLoadedAt = Date.now();
    manifestPromise = loadManifest();
  }
  return manifestPromise;
};

/**
 * 校验 nos-lib 文件
 * @param {string} path 归一化后的虚拟路径，如 /nos-lib/locale-text/...
 * @param {Blob} blob 文件内容
 * @returns {Promise<boolean>}
 */
export const verifyNosLibFile = async (path, blob) => {
  if (isLocalhostHost()) return true;

  const manifest = await getVerifiedManifest();
  if (!manifest) return false;

  const relativePath = path.replace(/^\/nos-lib\//, "");
  const entry = manifest.hashes.find((item) => item.path === relativePath);
  if (!entry || entry.size !== blob.size) return false;

  return (await sha256Hex(blob)) === entry.hash;
};
