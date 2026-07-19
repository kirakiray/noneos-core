import { getFileHandle } from "./file-system.js";
import { getContentType } from "./mime-types.js";

const TTL = 5 * 60 * 1000; // 5 分钟

// 每个路径上一次成功刷新时间（内存级 TTL）
// 过期条目在下次命中时被删除，Map 内仅保留最近 5 分钟内活跃的路径
const lastRefreshAt = new Map();

// 正在后台刷新中的路径集合，避免同一路径并发重复回源
const refreshing = new Set();

/**
 * @typedef {Object} CdnHandlerOptions
 * @property {string} tag - 日志标签（如 "gh" / "npm"）
 * @property {(path: string) => string} toCdnUrl - 将本地路径转为 CDN URL
 */

/**
 * 创建 CDN 资源处理器函数
 * @param {CdnHandlerOptions} opts
 * @returns {(ctx: { path: string }) => Promise<Response>}
 */
export const createCdnHandler = (opts) => {
  const { tag, toCdnUrl } = opts;

  /**
   * 后台从 CDN 拉取并覆盖本地缓存（离线时静默跳过）
   */
  const refreshInBackground = (path, rePath) => {
    if (!navigator.onLine) return;
    if (refreshing.has(path)) return;
    refreshing.add(path);

    (async () => {
      try {
        const response = await fetch(rePath, { cache: "no-store" });
        if (!response.ok) return;
        const blob = await response.blob();
        const targetHandle = await getFileHandle({ path, create: true });
        const writeStream = await targetHandle.createWritable();
        await writeStream.write(blob);
        await writeStream.close();
        lastRefreshAt.set(path, Date.now());
      } catch (err) {
        console.warn(`[${tag}] background refresh failed:`, path, err);
      } finally {
        refreshing.delete(path);
      }
    })();
  };

  return async ({ path }) => {
    const rePath = toCdnUrl(path);

    let targetHandle = await getFileHandle({ path }).catch(() => null);

    if (targetHandle) {
      const fileStream = await targetHandle.getFile();
      if (fileStream.size) {
        // 检查 TTL：过期条目从 Map 中删除回收内存，未过期则不做任何操作
        const cachedAt = lastRefreshAt.get(path);
        if (cachedAt) {
          if (Date.now() - cachedAt >= TTL) {
            lastRefreshAt.delete(path);
            refreshInBackground(path, rePath);
          }
        } else {
          // 无记录（SW 重启或过期已清理），触发后台刷新
          refreshInBackground(path, rePath);
        }
        return new Response(fileStream, {
          headers: { "Content-Type": getContentType(path) },
        });
      }
    }

    try {
      const response = await fetch(rePath, { cache: "no-store" });
      const blob = await response.blob();

      targetHandle = await getFileHandle({ path, create: true });
      const writeStream = await targetHandle.createWritable();
      await writeStream.write(blob);
      await writeStream.close();
      lastRefreshAt.set(path, Date.now());

      return new Response(blob, {
        headers: { "Content-Type": getContentType(path) },
      });
    } catch (error) {
      console.error(`[${tag}] fetch failed:`, error);
      return new Response(`Error fetching ${tag} resource: ${error.message}`, {
        status: 500,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }
  };
};