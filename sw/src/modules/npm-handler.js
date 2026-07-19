import { createCdnHandler } from "./cdn-handler.js";

/**
 * 从 NPM CDN 获取包文件
 * 映射 /npm/{package}@{version}/path → https://cdn.jsdelivr.net/npm/{package}@{version}/path
 */
export const handleNpmRequest = createCdnHandler({
  tag: "npm",
  toCdnUrl: (path) => path.replace(/^\/npm\//, "https://cdn.jsdelivr.net/npm/"),
});