import { createCdnHandler } from "./cdn-handler.js";

/**
 * 从 GitHub 仓库获取文件
 * 映射 /gh/{user}/{repo}@{tag}/path → https://cdn.jsdelivr.net/gh/{user}/{repo}@{tag}/path
 */
export const handleGitHubRequest = createCdnHandler({
  tag: "gh",
  toCdnUrl: (path) => path.replace(/^\/gh\//, "https://cdn.jsdelivr.net/gh/"),
});