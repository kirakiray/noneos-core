/**
 * 官方源代理（/nos-tool/ 工具集与 /nos-lib/_install/ 共用，不读写缓存）：
 * - localhost:3002：直接透传本地静态服务器
 * - 其他 localhost 端口：优先代理到 3002，失败回退官方源
 * - 生产环境：直接回源官方
 *
 * path 由 main.js 归一化为仓库物理路径（旧前缀别名也先归一化），
 * 保证回源目标始终是新路径；旧 URL 由托管层 301 兜底。
 */
export const handleOfficialSourceRequest = async ({ path, request }) => {
  const host = location.host;

  if (host === "localhost:3002") {
    return fetch(new URL(path, location.origin).href, request);
  }

  const returnOfficial = () => fetch(`https://core.noneos.com${path}`);

  if (/^localhost:/.test(host)) {
    try {
      return await fetch(new URL(path, "http://localhost:3002").href, request);
    } catch {
      return returnOfficial();
    }
  }

  return returnOfficial();
};
