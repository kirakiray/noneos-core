import { getFileHandle } from "./file-system.js";
import { getContentType } from "./mime-types.js";

const TTL = 5 * 60 * 1000; // 5 分钟

// 每个路径上一次成功刷新时间（内存级 TTL）
// SW 进程重启后清空，重启后首次命中缓存会额外触发一次后台刷新
const lastRefreshAt = new Map();

// 正在后台刷新中的路径集合，避免同一路径并发重复回源
const refreshing = new Set();

/**
 * 后台从 CDN 拉取并覆盖本地缓存
 * @param {string} path - 请求路径
 * @param {string} rePath - 实际 CDN URL
 */
const refreshInBackground = (path, rePath) => {
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
      console.warn("[npm] background refresh failed:", path, err);
    } finally {
      refreshing.delete(path);
    }
  })();
};

/**
 * 从 NPM CDN 获取包文件
 * @param {Object} options - 选项
 * @param {string} options.path - 请求路径
 * @param {string} options.originUrl - 原始请求 URL
 * @returns {Promise<Response>} 响应对象
 */
export const handleNpmRequest = async ({ path }) => {
  // 将 /npm/ 路径转换为 jsDelivr CDN URL
  // 例如: /npm/jquery@3.6.0/dist/jquery.min.js
  // 转换为: https://cdn.jsdelivr.net/npm/jquery@3.6.0/dist/jquery.min.js
  const rePath = path.replace(/^\/npm\//, "https://cdn.jsdelivr.net/npm/");

  let targetHandle = await getFileHandle({ path }).catch(() => null);

  if (targetHandle) {
    const fileStream = await targetHandle.getFile();
    if (fileStream.size) {
      // 命中缓存：立即返回；仅当内存中无记录或已超过 TTL 时才触发后台刷新
      const cachedAt = lastRefreshAt.get(path);
      if (!cachedAt || Date.now() - cachedAt >= TTL) {
        refreshInBackground(path, rePath);
      }
      const type = fileStream.type || getContentType(path);
      return new Response(fileStream, {
        headers: {
          "Content-Type": type,
        },
      });
    }
  }

  try {
    // 请求实际文件
    const response = await fetch(rePath);

    // 检查响应状态
    if (!response.ok) {
      throw new Error(
        `Failed to fetch ${rePath}: ${response.status} ${response.statusText}`,
      );
    }

    const blob = await response.blob();

    // 写入缓存
    targetHandle = await getFileHandle({ path, create: true });
    const writeStream = await targetHandle.createWritable();
    await writeStream.write(blob);
    await writeStream.close();
    lastRefreshAt.set(path, Date.now());

    const type = blob.type || getContentType(path);

    // 转化为新的 Response 对象
    return new Response(blob, {
      headers: {
        "Content-Type": type,
      },
    });
  } catch (error) {
    console.error("Error fetching npm package:", error);

    return new Response(`Error fetching npm package: ${error.message}`, {
      status: 500,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
      },
    });
  }
};
