import { getFileHandle } from "./file-system.js";
import { getContentType } from "./mime-types.js";
import { shouldRefresh, refreshInBackground } from "./swr-cache.js";

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

  return async ({ path }) => {
    const rePath = toCdnUrl(path);

    let targetHandle = await getFileHandle({ path }).catch(() => null);

    if (targetHandle) {
      const fileStream = await targetHandle.getFile();
      if (fileStream.size) {
        if (shouldRefresh(path)) {
          refreshInBackground({ path, rePath, tag });
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