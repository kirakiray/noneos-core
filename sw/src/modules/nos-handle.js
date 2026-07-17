import { getFileHandle } from "./file-system.js";
import { getContentType } from "./mime-types.js";

export const handleNosRequest = async ({ path, request, systemConfig }) => {
  const host = location.host;

  // localhost:3002 调试模式直接请求资源，不读取 OPFS 缓存
  if (host === "localhost:3002") {
    return fetch(request);
  }

  // 其他 localhost 端口下，优先将 /nos/ 请求代理到 localhost:3002 的在线资源
  if (/^localhost:/.test(host)) {
    try {
      const newUrl = request.url.replace(/:(\d+)/, ":3002");
      return await fetch(newUrl);
    } catch {
      // localhost:3002 未启动，继续走默认路线
    }
  }

  if (!systemConfig || !systemConfig.mode || systemConfig.mode === "online") {
    // 没有配置数据时，直接返回线上数据
    return fetch(request);
  }

  if (systemConfig.mode === "local") {
    try {
      const rePath = path.replace(/^\/nos\//, systemConfig.nosMapPath + "/");

      let targetHandle = await getFileHandle({ path: rePath }).catch(
        () => null,
      );

      if (targetHandle) {
        const fileStream = await targetHandle.getFile();

        if (fileStream.size) {
          return new Response(fileStream, {
            headers: {
              "Content-Type": getContentType(path),
            },
          });
        }
      }

      return fetch(request);
    } catch (err) {
      return fetch(request);
    }
  }
};
