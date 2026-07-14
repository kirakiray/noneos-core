import { getFileHandle } from "./file-system.js";
import { getContentType } from "./mime-types.js";

export const handleNosRequest = async ({ path, request, systemConfig }) => {
  const host = location.host;

  // 调试模式下直接请求资源，不读取 OPFS 缓存
  if (host === "localhost:3002") {
    return fetch(request);
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
