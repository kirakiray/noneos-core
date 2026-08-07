import { getFileHandle, getRootDirectory } from "./file-system.js";
import { getContentType } from "./mime-types.js";

/**
 * 宿主项目离线缓存处理器
 *
 * 允许使用 noneos-core 的项目通过 manifest 文件（host-cache.json）
 * 声明需要离线缓存的文件列表，SW 会在后台预缓存这些文件，
 * 并在 fetch 时优先从 OPFS 缓存返回。
 *
 * OPFS 结构:
 *   host-cache/
 *     manifest.json    # 持久化的 manifest
 *     files/           # 缓存文件，保持原始路径结构
 *       index.html
 *       apps/main/home.html
 *       ...
 */

const HOST_CACHE_DIR = "host-cache";
const MANIFEST_FILE = "manifest.json";
const FILES_DIR = "files";

// 内存状态
let hostManifest = null; // { name, version, files: [] }
let fileSet = null; // Set<string>，快速查找
let precaching = false; // 是否正在预缓存

// SWR 状态（host-cache 专用，与 cache-handlers.js 隔离）
const SWR_TTL = 5 * 60 * 1000; // 5 分钟
const lastRefreshAt = new Map(); // filePath -> 最近一次后台刷新时间
const refreshing = new Set(); // 正在后台刷新的 filePath，用于去重

// --- 配置 ---

/**
 * 是否为开发环境（localhost）。
 * 开发环境下旁路 OPFS 缓存，确保宿主项目源码改动无需 bump version 即可立即生效。
 */
const isDevEnv = () => {
  const hostname = self.location.hostname;
  return hostname === "localhost" || hostname === "127.0.0.1";
};

const getManifestPath = () => {
  if (
    typeof globalThis.HOST_CACHE_CONFIG === "object" &&
    globalThis.HOST_CACHE_CONFIG?.manifestPath
  ) {
    return globalThis.HOST_CACHE_CONFIG.manifestPath;
  }
  return "/host-cache.json";
};

// --- Manifest 持久化 ---

const loadManifestFromOPFS = async () => {
  try {
    const handle = await getFileHandle({
      path: `${HOST_CACHE_DIR}/${MANIFEST_FILE}`,
    });
    const file = await handle.getFile();
    const text = await file.text();
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
};

const saveManifestToOPFS = async (manifest) => {
  const handle = await getFileHandle({
    path: `${HOST_CACHE_DIR}/${MANIFEST_FILE}`,
    create: true,
  });
  const stream = await handle.createWritable();
  await stream.write(JSON.stringify(manifest, null, 2));
  await stream.close();
};

// --- 目录操作工具 ---

const getDirHandleByPath = async (dirPath, { create } = {}) => {
  const rootHandle = await getRootDirectory();
  const parts = dirPath.split("/").filter(Boolean);
  let handle = rootHandle;
  for (const part of parts) {
    handle = await handle.getDirectoryHandle(part, { create });
  }
  return handle;
};

const deleteCachedFile = async (filePath) => {
  const opfsPath = `${HOST_CACHE_DIR}/${FILES_DIR}/${filePath}`;
  const parts = opfsPath.split("/");
  const fileName = parts.pop();
  const dirPath = parts.join("/");

  const dirHandle = await getDirHandleByPath(dirPath).catch(() => null);
  if (dirHandle) {
    await dirHandle.removeEntry(fileName).catch(() => {});
  }
};

// --- 预缓存 ---

const broadcast = (data) => {
  self.clients.matchAll().then((clients) => {
    for (const client of clients) {
      client.postMessage(data);
    }
  });
};

const precacheFile = async (filePath) => {
  const url = filePath.startsWith("/") ? filePath : "/" + filePath;
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`${filePath}: ${response.status} ${response.statusText}`);
  }
  const blob = await response.blob();

  const opfsPath = `${HOST_CACHE_DIR}/${FILES_DIR}/${filePath}`;
  const handle = await getFileHandle({ path: opfsPath, create: true });
  const stream = await handle.createWritable();
  await stream.write(blob);
  await stream.close();
};

const precacheFiles = async (manifest) => {
  const files = manifest.files || [];
  let downloaded = 0;
  let failed = 0;

  for (const filePath of files) {
    try {
      await precacheFile(filePath);
      downloaded++;
    } catch (err) {
      console.warn(`[host-cache] precache failed: ${filePath}`, err.message || err);
      failed++;
    }
    broadcast({
      type: "host-cache-progress",
      total: files.length,
      downloaded,
      failed,
    });
  }

  return { downloaded, failed, total: files.length };
};

// --- 更新流程 ---

export const updateHostCache = async (newManifest) => {
  if (precaching) {
    console.log("[host-cache] update skipped: already precaching");
    return { ok: false, reason: "already-precaching" };
  }
  precaching = true;

  try {
    const oldFiles = fileSet || new Set();
    const newFiles = new Set(newManifest.files || []);

    // 立即更新内存状态（fetch 拦截可以生效）
    hostManifest = newManifest;
    fileSet = newFiles;

    // 删除不再需要的旧文件
    for (const filePath of oldFiles) {
      if (!newFiles.has(filePath)) {
        await deleteCachedFile(filePath).catch(() => {});
      }
    }

    // 预缓存所有文件（覆盖已有文件，确保内容最新）
    const result = await precacheFiles(newManifest);

    // 预缓存完成后持久化 manifest
    await saveManifestToOPFS(newManifest);

    broadcast({ type: "host-cache-complete", ...result });

    console.log(
      `[host-cache] update success: ${result.downloaded}/${result.total} downloaded, ${result.failed} failed`,
    );
    return { ok: true, ...result };
  } catch (err) {
    console.error("[host-cache] update failed:", err);
    return { ok: false, reason: "update-error", error: err.message };
  } finally {
    precaching = false;
  }
};

// --- 初始化 ---

export const initHostCache = async () => {
  // 先从 OPFS 加载持久化的 manifest
  hostManifest = await loadManifestFromOPFS();
  if (hostManifest) {
    fileSet = new Set(hostManifest.files || []);
    console.log(`[host-cache] loaded from OPFS: ${hostManifest.name}@${hostManifest.version}`);
  }

  // 尝试从网络拉取最新 manifest
  const manifestPath = getManifestPath();
  try {
    const response = await fetch(manifestPath, { cache: "no-store" });
    if (response.ok) {
      const latest = await response.json();
      if (!hostManifest || latest.version !== hostManifest.version) {
        // 版本变化或首次加载，触发预缓存
        console.log(`[host-cache] version changed, triggering update: ${latest.version}`);
        await updateHostCache(latest);
      } else {
        // 版本相同，仅更新内存状态
        hostManifest = latest;
        fileSet = new Set(latest.files || []);
        console.log(`[host-cache] version up-to-date: ${latest.version}`);
      }
    }
  } catch (err) {
    console.warn("[host-cache] init fetch failed, using OPFS cache:", err.message || err);
  }
};

// --- Fetch 拦截 ---

/**
 * 同步检查路径是否在 host-cache 缓存列表中。
 * 用于 main.js 在调用 respondWith 之前做快速判断。
 */
export const isHostCachedFile = (path) => {
  if (!fileSet) return false;
  // 开发环境（localhost）旁路 OPFS 缓存，直接走网络
  if (isDevEnv()) return false;
  const filePath = path.replace(/^\//, "");
  if (!fileSet.has(filePath)) return false;
  // manifest 文件本身不走缓存，始终从网络获取
  if (path === getManifestPath()) return false;
  return true;
};

/**
 * 检查是否需要后台刷新；顺带回收过期条目。
 */
const shouldRefresh = (filePath) => {
  const t = lastRefreshAt.get(filePath);
  if (!t) return true;
  if (Date.now() - t >= SWR_TTL) {
    lastRefreshAt.delete(filePath);
    return true;
  }
  return false;
};

/**
 * SWR 后台刷新：拉取最新文件覆盖 OPFS。
 * 离线跳过，并发去重。完成后下次刷新即可拿到新版本。
 */
const refreshInBackground = (filePath, request) => {
  if (!navigator.onLine) return;
  if (refreshing.has(filePath)) return;
  refreshing.add(filePath);

  (async () => {
    try {
      const response = await fetch(request, { cache: "no-store" });
      if (!response.ok) return;
      const blob = await response.blob();
      const opfsPath = `${HOST_CACHE_DIR}/${FILES_DIR}/${filePath}`;
      const handle = await getFileHandle({ path: opfsPath, create: true });
      const stream = await handle.createWritable();
      await stream.write(blob);
      await stream.close();
      lastRefreshAt.set(filePath, Date.now());
      console.log(`[host-cache] background refreshed: ${filePath}`);
    } catch (err) {
      console.warn(
        `[host-cache] background refresh failed: ${filePath}`,
        err.message || err,
      );
    } finally {
      refreshing.delete(filePath);
    }
  })();
};

/**
 * 处理 host-cache 文件请求。
 * 生产环境采用 SWR：命中缓存立即返回，TTL 过期时后台刷新（下次刷新生效）；
 * 缓存未命中时同步回退网络并写入缓存。
 */
export const handleHostCacheRequest = async ({ path, request }) => {
  if (request.method !== "GET") return null;

  const filePath = path.replace(/^\//, "");
  if (!fileSet || !fileSet.has(filePath)) return null;

  // 尝试从 OPFS 缓存读取
  const opfsPath = `${HOST_CACHE_DIR}/${FILES_DIR}/${filePath}`;
  const handle = await getFileHandle({ path: opfsPath }).catch(() => null);

  if (handle) {
    const file = await handle.getFile();
    if (file.size) {
      // SWR：立即返回缓存，TTL 过期时后台刷新
      if (shouldRefresh(filePath)) {
        refreshInBackground(filePath, request);
      }
      return new Response(file, {
        headers: { "Content-Type": getContentType(path) },
      });
    }
  }

  // 缓存未命中：回退网络并写入缓存
  try {
    const response = await fetch(request);
    if (response.ok) {
      const blob = await response.blob();
      const cacheHandle = await getFileHandle({
        path: opfsPath,
        create: true,
      });
      const stream = await cacheHandle.createWritable();
      await stream.write(blob);
      await stream.close();
      lastRefreshAt.set(filePath, Date.now());
      return new Response(blob, {
        headers: { "Content-Type": getContentType(path) },
      });
    }
    return response;
  } catch {
    return null;
  }
};

// --- 状态查询路由 ---

export const handleHostCacheStatus = () => {
  return new Response(
    JSON.stringify({
      name: hostManifest?.name || null,
      version: hostManifest?.version || null,
      fileCount: hostManifest?.files?.length || 0,
      precaching,
    }),
    { headers: { "Content-Type": "application/json" } },
  );
};

// --- 触发更新路由 ---

/**
 * 触发 host-cache 更新。
 * SW 自行从网络拉取最新 manifest，与 OPFS 中持久化的版本对比，版本变化时才执行预缓存。
 */
export const triggerHostCacheUpdate = async () => {
  let manifest;
  try {
    const response = await fetch(getManifestPath(), { cache: "no-store" });
    if (response.ok) {
      manifest = await response.json();
    }
  } catch {}

  if (!manifest) {
    console.warn("[host-cache] update failed: manifest not available");
    return new Response(
      JSON.stringify({ ok: false, reason: "manifest-not-available" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }

  // 从 OPFS 读取持久化的版本进行对比（而非内存，确保手动删除 OPFS 后能重新拉取）
  const persisted = await loadManifestFromOPFS();
  if (persisted && manifest.version === persisted.version) {
    console.log(`[host-cache] version up-to-date: ${manifest.version}`);
    return new Response(
      JSON.stringify({ ok: true, reason: "version-up-to-date", version: manifest.version }),
      { headers: { "Content-Type": "application/json" } },
    );
  }

  console.log(`[host-cache] triggering update: ${manifest.name}@${manifest.version}`);
  const result = await updateHostCache(manifest);
  return new Response(JSON.stringify(result), {
    headers: { "Content-Type": "application/json" },
  });
};

// --- postMessage 处理 ---

export const handleHostCacheMessage = async (data) => {
  if (data?.type !== "host-cache-update") return null;

  let manifest = data.manifest;
  if (!manifest) {
    // 前端未提供 manifest，SW 自行拉取
    try {
      const response = await fetch(getManifestPath(), { cache: "no-store" });
      if (response.ok) {
        manifest = await response.json();
      }
    } catch {}
  }

  if (!manifest) {
    return { ok: false, reason: "manifest-not-available" };
  }

  // 从 OPFS 读取持久化的版本进行对比
  const persisted = await loadManifestFromOPFS();
  if (persisted && manifest.version === persisted.version) {
    return { ok: true, reason: "version-up-to-date", version: manifest.version };
  }

  return await updateHostCache(manifest);
};
