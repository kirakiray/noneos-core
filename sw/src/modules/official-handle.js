/**
 * 官方源代理（/nos-tool/ 工具集与 /nos-lib/_install/ 共用，不读写缓存）：
 * - localhost:3002：直接透传本地静态服务器
 * - 其他 localhost 端口（含 127.0.0.1 / [::1]）：优先代理到 3002，失败回退官方源
 * - 生产环境：直接回源官方
 *
 * path 由 main.js 归一化为仓库物理路径（旧前缀别名也先归一化），
 * 保证回源目标始终是新路径；旧 URL 由托管层 301 兜底。
 *
 * 可选 verify(path, blob)：对 `_install/` 等 nos-lib 资源做签名清单校验，
 * 不通过时返回 502 且不返回内容。
 */
import { isLocalhostHost } from "./noslib-verify.js";

const verifiedResponse = async (path, response, verify) => {
  if (!verify || isLocalhostHost() || !response.ok) return response;

  const blob = await response.blob();
  if (!(await verify(path, blob))) {
    return new Response(`nos-lib verification failed: ${path}`, {
      status: 502,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  const headers = new Headers();
  const contentType = response.headers.get("Content-Type");
  if (contentType) headers.set("Content-Type", contentType);

  return new Response(blob, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};

export const handleOfficialSourceRequest = async ({ path, request, verify }) => {
  // 不能把 fetch 事件的整体 request 作为 init 传给 fetch(url, request)：
  // 导航请求的 mode 是 "navigate"，二次构造会直接抛 TypeError，
  // 因此只转发方法与头
  const fetchOptions = { method: request.method, headers: request.headers };
  const finish = (response) => verifiedResponse(path, response, verify);
  const host = location.host;

  if (host === "localhost:3002") {
    return finish(await fetch(new URL(path, location.origin).href, fetchOptions));
  }

  const returnOfficial = async () =>
    finish(await fetch(`https://core.noneos.com${path}`));

  if (isLocalhostHost()) {
    // 依次尝试：3002 开发服务器 → 同域（如 30028 正式部署端口、静态服务器）→ 官方源
    // fetch 对 404 等 HTTP 错误状态不会 throw，候选源返回非 ok 响应时
    // 必须视为失败继续回退，否则文件缺失时永远到不了官方源
    try {
      const res = await fetch(new URL(path, "http://localhost:3002").href, fetchOptions);
      if (res.ok) {
        return finish(res);
      }
    } catch {
      // 3002 未启动
    }
    try {
      const res = await fetch(new URL(path, location.origin).href, fetchOptions);
      if (res.ok) {
        return finish(res);
      }
    } catch {
      // 同域也没有该文件
    }
    return returnOfficial();
  }

  return returnOfficial();
};
