import { getFileHandle } from "./file-system.js";

const TTL = 5 * 60 * 1000; // 5 分钟

// 每个路径上一次成功刷新时间（内存级 TTL）
// 过期条目在下次命中时被删除，Map 内仅保留最近 5 分钟内活跃的路径
const lastRefreshAt = new Map();

// 正在后台刷新中的路径集合，避免同一路径并发重复回源
const refreshing = new Set();

/**
 * 检查路径是否需要后台刷新
 * 过期条目自动从 Map 中删除以回收内存
 * @param {string} path
 * @returns {boolean} true 表示需要触发刷新
 */
export function shouldRefresh(path) {
  const cachedAt = lastRefreshAt.get(path);
  if (cachedAt) {
    if (Date.now() - cachedAt >= TTL) {
      lastRefreshAt.delete(path);
      return true;
    }
    return false;
  }
  return true; // 无记录（SW 重启或过期已清理）
}

/**
 * 标记路径已刷新
 * @param {string} path
 */
export function markRefreshed(path) {
  lastRefreshAt.set(path, Date.now());
}

/**
 * 后台刷新资源
 *
 * @param {Object} options
 * @param {string} options.path  - 本地缓存路径
 * @param {string} options.rePath - 回源 URL
 * @param {string} [options.tag]  - 日志标签
 * @param {(blob: Blob, path: string) => Promise<Blob|null|void>} [options.onWrite]
 *        写入前回调，可返回：
 *        - Blob：替换写入内容
 *        - null：跳过写盘
 *        - undefined：写入原始 blob
 */
export function refreshInBackground({ path, rePath, tag, onWrite }) {
  if (!navigator.onLine) return;
  if (refreshing.has(path)) return;
  refreshing.add(path);

  (async () => {
    try {
      const response = await fetch(rePath, { cache: "no-store" });
      if (!response.ok) return;
      const blob = await response.blob();

      const writeResult = onWrite ? await onWrite(blob, path) : blob;
      if (writeResult !== null) {
        const targetHandle = await getFileHandle({ path, create: true });
        const writeStream = await targetHandle.createWritable();
        await writeStream.write(writeResult ?? blob);
        await writeStream.close();
      }
      // 无论是否写盘，都标记已刷新，避免重复回源
      markRefreshed(path);
    } catch (err) {
      console.warn(`[${tag}] background refresh failed:`, path, err);
    } finally {
      refreshing.delete(path);
    }
  })();
}