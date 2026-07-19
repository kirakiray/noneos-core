import { getFileHandle } from "./file-system.js";
import { getContentType } from "./mime-types.js";

/**
 * 统一的 SWR（Stale-While-Revalidate）资源处理器。
 *
 * 策略：
 * - 缓存命中 & TTL 内   → 直接返回缓存
 * - 缓存命中 & TTL 过期 → 立即返回缓存，后台刷新
 * - 缓存未命中          → 同步网络请求，写盘后返回
 * - 网络优先模式        → 每次都先请求网络，失败时回退缓存
 *
 * 内存级 TTL：仅保留最近 5 分钟内活跃的路径。SW 进程重启后清空。
 */

const TTL = 5 * 60 * 1000;

// 所有 handler 共用一份状态
const lastRefreshAt = new Map(); // path -> 最近一次成功刷新时间
const refreshing = new Set(); // 正在后台刷新的路径，用于去重

/**
 * 检查是否需要刷新；顺带回收过期条目
 */
const shouldRefresh = (path) => {
  const t = lastRefreshAt.get(path);
  if (!t) return true;
  if (Date.now() - t >= TTL) {
    lastRefreshAt.delete(path);
    return true;
  }
  return false;
};

/**
 * 按顺序尝试多个源，返回第一个成功的 Blob
 */
const fetchFromSources = async (sources) => {
  let lastError;
  for (const url of sources) {
    try {
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) {
        lastError = new Error(`${url}: ${response.status} ${response.statusText}`);
        continue;
      }
      return await response.blob();
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error("No source available");
};

/**
 * 将 blob 写入 OPFS
 */
const writeToCache = async (path, blob) => {
  const targetHandle = await getFileHandle({ path, create: true });
  const writeStream = await targetHandle.createWritable();
  await writeStream.write(blob);
  await writeStream.close();
};

/**
 * 后台异步刷新（离线守卫 + 去重）
 */
const refreshInBackground = (path, sources, tag) => {
  if (!navigator.onLine) return;
  if (refreshing.has(path)) return;
  refreshing.add(path);

  (async () => {
    try {
      const blob = await fetchFromSources(sources);
      await writeToCache(path, blob);
      lastRefreshAt.set(path, Date.now());
    } catch (err) {
      console.warn(`[${tag}] background refresh failed:`, path, err);
    } finally {
      refreshing.delete(path);
    }
  })();
};

/**
 * 读取 OPFS 缓存
 * @returns {Promise<File|null>}
 */
const readCache = async (path) => {
  const targetHandle = await getFileHandle({ path }).catch(() => null);
  if (!targetHandle) return null;
  const file = await targetHandle.getFile();
  return file.size ? file : null;
};

const okResponse = (body, path) =>
  new Response(body, { headers: { "Content-Type": getContentType(path) } });

const errResponse = (tag, err) =>
  new Response(`Error fetching ${tag} resource: ${err.message || err}`, {
    status: 500,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });

/**
 * 创建统一的 SWR handler
 *
 * @param {Object} opts
 * @param {string} opts.tag                    日志标签
 * @param {(ctx: {path: string, request: Request}) => string[]} opts.resolveSources
 *        返回按优先级排列的候选源 URL 数组
 * @param {(ctx: {path: string, request: Request}) => boolean} [opts.networkFirstWhen]
 *        返回 true 时改用"网络优先"模式（如 localhost dev）
 */
const createHandler = ({ tag, resolveSources, networkFirstWhen }) => {
  return async ({ path, request }) => {
    const ctx = { path, request };
    const sources = resolveSources(ctx);
    const networkFirst = networkFirstWhen ? networkFirstWhen(ctx) : false;

    // 网络优先：dev 模式下始终尝试网络，失败回退缓存
    if (networkFirst) {
      try {
        const blob = await fetchFromSources(sources);
        await writeToCache(path, blob);
        lastRefreshAt.set(path, Date.now());
        return okResponse(blob, path);
      } catch {
        const cached = await readCache(path);
        if (cached) return okResponse(cached, path);
        // 全部失败，落到下面的错误处理
      }
    }

    // SWR：缓存优先，过期后台刷新
    const cached = await readCache(path);
    if (cached) {
      if (shouldRefresh(path)) refreshInBackground(path, sources, tag);
      return okResponse(cached, path);
    }

    // 缓存未命中：同步网络
    try {
      const blob = await fetchFromSources(sources);
      await writeToCache(path, blob);
      lastRefreshAt.set(path, Date.now());
      return okResponse(blob, path);
    } catch (err) {
      console.error(`[${tag}] fetch failed:`, err);
      return errResponse(tag, err);
    }
  };
};

// ---------- 具体 handler ----------

/**
 * /gh/{user}/{repo}@{tag}/path → https://cdn.jsdelivr.net/gh/{user}/{repo}@{tag}/path
 */
export const handleGitHubRequest = createHandler({
  tag: "gh",
  resolveSources: ({ path }) => [
    path.replace(/^\/gh\//, "https://cdn.jsdelivr.net/gh/"),
  ],
});

/**
 * /npm/{package}@{version}/path → https://cdn.jsdelivr.net/npm/{package}@{version}/path
 */
export const handleNpmRequest = createHandler({
  tag: "npm",
  resolveSources: ({ path }) => [
    path.replace(/^\/npm\//, "https://cdn.jsdelivr.net/npm/"),
  ],
});

/**
 * /ncomp/xxx
 * - localhost dev：优先 localhost:3002 → 官方源 → 同域兜底（网络优先）
 * - 生产环境：直接走官方源（SWR）
 */
export const handleNcompRequest = createHandler({
  tag: "ncomp",
  networkFirstWhen: () => /^localhost:/.test(location.host),
  resolveSources: ({ path, request }) => {
    const afterHost = request.url.replace(/^https?:\/\/[^\/]+\//, "");
    const isDev = /^localhost:/.test(location.host);
    return [
      isDev ? request.url.replace(/:(\d+)/, ":3002") : null,
      `https://core.noneos.com/${afterHost}`,
      isDev ? new URL(path, location.origin).href : null,
    ].filter(Boolean);
  },
});