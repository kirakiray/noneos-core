import { getFileHandle } from "./file-system.js";
import { getContentType } from "./mime-types.js";

export const handleNosRequest = async ({ path, request, systemConfig }) => {
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
